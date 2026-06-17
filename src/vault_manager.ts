import {
  ethers,
  parseUnits,
  formatUnits,
  ContractTransactionReceipt,
  EthersError,
  NonceManager,
} from "ethers";
import { MulticallWrapper, MulticallProvider } from "ethers-multicall-provider";
import { HermesClient, PriceUpdate } from "@pythnetwork/hermes-client";
import IPythABI from "@pythnetwork/pyth-sdk-solidity/abis/IPyth.json";
import {
  fixDecimals,
  CreateVaultParamsStruct,
  calculateTokenAmounts,
  zeroBigNumber,
} from "./utils";
import { BlockchainConfig, BasicSettings, VaultData } from "./types";
import { readFileSync } from "fs";

import FactoryABI from "../abi/Factory.json";
import RouterABI from "../abi/Router.json";
import VaultABI from "../abi/Vault.json";
import IERC20ABI from "../abi/IERC20.json";
import VaultCore from "../abi/VaultCore.json";
import CollateralPoolABI from "../abi/CollateralPool.json";
import CollateralPoolV2ABI from "../abi/CollateralPoolV2.json";
import VaultBatchManagerABI from "../abi/VaultBatchManager.json";
import { isOzRelayerEnabled, OzRelayerClient } from "./oz_relayer_client";

const DEFAULT_VAULT_FETCH_COUNT = 100;

type VaultRangeOptions = {
  start?: number;
  count?: number;
};

type SubscribeVaultSignatureOptions = {
  signature?: string;
  signedYieldValue?: string;
  nonce?: string;
  deadline?: string;
};

export class VaultManager {
  config: BlockchainConfig;
  basicSettings: BasicSettings;
  pythConnection: HermesClient;
  provider: MulticallProvider;
  signer: ethers.Signer;
  private readonly txMode: "local" | "relayer";
  private readonly ozRelayer?: OzRelayerClient;
  factory: ethers.Contract;
  router: ethers.Contract;
  vaultBatchManager: ethers.Contract;
  pythPriceFeed: ethers.Contract;

  constructor(config: BlockchainConfig, basicSettings: BasicSettings) {
    this.txMode = isOzRelayerEnabled() ? "relayer" : "local";
    this.ozRelayer =
      this.txMode === "relayer" ? new OzRelayerClient() : undefined;
    this.config = config;
    this.basicSettings = basicSettings;
    this.pythConnection = new HermesClient(basicSettings.hermesApiBaseUrl, {
      timeout: 30000,
    });
    this._checkWeb3Settings();
    this.provider = MulticallWrapper.wrap(
      new ethers.JsonRpcProvider(this.config.rpcNode),
    );
    this.signer = this._initializeWallet();
  }

  private _initializeWallet(): ethers.Signer {
    if (this.txMode === "relayer") {
      if (!this.config.account) {
        throw new Error(
          "Relayer mode requires `account` to be set in config.json",
        );
      }
      return new ethers.VoidSigner(this.config.account, this.provider);
    }
    try {
      const walletJsonContent = readFileSync(
        `${process.cwd()}/${this.config.jsonWallet}`,
        "utf8",
      );
      const wallet = ethers.Wallet.fromEncryptedJsonSync(
        walletJsonContent,
        this.config.passphrase,
      );

      try {
        const connectedWallet = wallet.connect(this.provider);
        return new NonceManager(connectedWallet);
      } catch {
        throw new Error(`Failed to connect wallet to provider`);
      }
    } catch {
      throw new Error(`Wallet initialization failed`);
    }
  }

  private _isRelayerMode(): boolean {
    return this.txMode === "relayer";
  }

  private async _getSignerAddress(): Promise<string> {
    return await this.signer.getAddress();
  }

  private async _sendContractTxAndWait(args: {
    contract: ethers.Contract;
    functionName: string;
    functionArgs: unknown[];
    overrides?: ethers.TransactionRequest;
  }): Promise<ContractTransactionReceipt> {
    const { contract, functionName, functionArgs, overrides } = args;

    if (!this._isRelayerMode()) {
      const fn = (
        contract as unknown as Record<
          string,
          (...fnArgs: unknown[]) => Promise<unknown>
        >
      )[functionName];
      if (typeof fn !== "function") {
        throw new Error(`Contract method not found: ${functionName}`);
      }
      const tx = overrides
        ? await fn(...functionArgs, overrides)
        : await fn(...functionArgs);
      const receipt = await (tx as { wait: () => Promise<unknown> }).wait();
      return receipt as ContractTransactionReceipt;
    }

    if (!this.ozRelayer) {
      throw new Error("Relayer client is not initialized");
    }

    const to = contract.target as string | undefined;
    if (!to) {
      throw new Error(`Missing contract target for ${functionName}`);
    }

    const data = contract.interface.encodeFunctionData(
      functionName,
      functionArgs as ReadonlyArray<unknown>,
    );
    const value =
      overrides?.value !== undefined ? BigInt(overrides.value.toString()) : 0n;

    let gasLimit: bigint | number | undefined;
    if (overrides?.gasLimit !== undefined) {
      const gl = overrides.gasLimit;
      gasLimit =
        typeof gl === "bigint" || typeof gl === "number"
          ? gl
          : BigInt(gl.toString());
    }

    const maxAttempts = 20;
    const timeoutMs = 120_000;
    const pollMs = 1_000;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const submitted = await this.ozRelayer.sendEvmTransaction({
        to,
        data,
        value,
        gasLimit,
      });
      console.log(
        `[relayer] submitted tx id=${submitted.id} for ${functionName} (attempt ${attempt}/${maxAttempts})`,
      );

      const startedAt = Date.now();

      while (true) {
        const tx = await this.ozRelayer.getTransaction(submitted.id);

        // Check terminal status
        if (tx.status === "mined" || tx.status === "confirmed") {
          console.log(`[relayer] tx ${tx.status} hash=${tx.hash}`);
          const receipt = await this.provider.waitForTransaction(tx.hash!);
          return receipt as ContractTransactionReceipt;
        }

        if (
          tx.status === "failed" ||
          tx.status === "canceled" ||
          tx.status === "expired"
        ) {
          // Check if it's a nonce-related failure - retry if so
          const reason = (tx.status_reason ?? "").toLowerCase();
          if (reason.includes("nonce") || reason.includes("already known")) {
            console.warn(
              `[relayer] ${tx.status}: ${tx.status_reason}, retrying...`,
            );
            break; // Break inner loop to retry
          }
          throw new Error(
            `Relayer tx ${tx.status}: ${tx.status_reason ?? "unknown"}`,
          );
        }

        // Timeout check
        if (Date.now() - startedAt > timeoutMs) {
          throw new Error(`Timeout waiting for tx ${submitted.id}`);
        }

        await new Promise((r) => setTimeout(r, pollMs));
      }
    }

    throw new Error(
      `Failed after ${maxAttempts} attempts due to nonce conflicts`,
    );
  }

  _checkWeb3Settings() {
    if (!this.config.rpcNode) {
      throw new Error("rpcNode is not set");
    }
    if (this.txMode === "local") {
      if (!this.config.jsonWallet) {
        throw new Error("wallet path is not set");
      }
      if (!this.config.passphrase) {
        throw new Error("passphrase is not set");
      }
    } else if (!this.config.account) {
      throw new Error("account is not set (required for relayer mode)");
    }
    if (!this.config.factory) {
      throw new Error("factory is not set");
    }
    if (!this.config.router) {
      throw new Error("router is not set");
    }
    if (!this.config.vaultBatchManager) {
      throw new Error("vaultBatchManager is not set");
    }
  }

  private async _simulateTransaction(
    contractMethod: () => Promise<unknown>,
  ): Promise<void> {
    // Disable multicall for staticCall to avoid parsing issues with custom errors
    const originalMulticallState = this.provider.isMulticallEnabled;
    this.provider.isMulticallEnabled = false;

    try {
      await contractMethod();
      console.log(`Transaction simulation passed`);
    } catch (simulationError: unknown) {
      console.error(`Transaction simulation failed`);
      const error = simulationError as {
        reason?: string;
        message?: string;
        data?: string;
      };
      console.error("Revert reason:", error.reason || error.message);
      if (error.data) {
        console.error("Error data:", error.data);
      }
      throw simulationError;
    } finally {
      // Restore original multicall state
      this.provider.isMulticallEnabled = originalMulticallState;
    }
  }

  _checkTradingPairSettings(tradingPair: string) {
    if (!tradingPair) {
      throw new Error("tradingPair is not set");
    }
    if (!Object.keys(this.config.tradingPairs).includes(tradingPair)) {
      throw new Error("tradingPair is not valid");
    }
    if (!this.config.tradingPairs[tradingPair].baseToken) {
      throw new Error("baseToken is not set");
    }
    if (!this.config.tradingPairs[tradingPair].quoteToken) {
      throw new Error("quoteToken is not set");
    }
    if (!this.config.tradingPairs[tradingPair].priceFeed.decimals) {
      throw new Error("decimals is not set");
    }
  }

  async _getToken(tokenAddress: string) {
    return new ethers.Contract(tokenAddress, IERC20ABI, this.signer);
  }

  async _approveERC20(token: ethers.Contract, spender: string, amount: string) {
    const signerAddress = await this._getSignerAddress();
    const balance = await token.balanceOf(signerAddress);
    if (balance < BigInt(amount)) {
      const tokenName = await token.name();
      throw new Error(`Insufficient ${tokenName} balance`);
    }
    await this._simulateTransaction(() =>
      token.approve.staticCall(spender, amount),
    );
    const receipt = await this._sendContractTxAndWait({
      contract: token,
      functionName: "approve",
      functionArgs: [spender, amount],
    });
    if (receipt.status !== 1) {
      const tokenName = await token.name();
      throw new Error(`ERC20 approve failed for ${tokenName}`);
    }
  }

  async _getHermesPriceUpdateAtTimestamp(
    expiry: number,
    tradingPair: string,
  ): Promise<PriceUpdate> {
    if (
      !this.config.tradingPairs[tradingPair] ||
      !this.config.tradingPairs[tradingPair].priceFeed
    ) {
      throw `Pyth price feed for ${tradingPair} doesn't exist.`;
    }
    const pythPriceFeedId =
      this.config.tradingPairs[tradingPair].priceFeed.type == "PYTH" &&
      this.config.tradingPairs[tradingPair].priceFeed.id;

    // NOTE: There are two options:
    // * encoding: 'hex' or 'base64'. Default is 'hex'.
    // * parsed: default is true.
    // So we pass an empty object when getting price updates later.
    //
    // Ref: https://hermes.pyth.network/docs/#/rest/timestamp_price_updates
    let updatePriceData: PriceUpdate;

    if (expiry > Date.now() / 1000) {
      // NOTE: Special case for debugging goes here.
      // When we use a dummy expiry in the future to trigger the execution, so we
      // get the latest price update instead.
      updatePriceData = await this.pythConnection.getLatestPriceUpdates(
        [pythPriceFeedId],
        {},
      );
    } else {
      // NOTE: Normal case goes here.
      // Timestamp greater than current results in HTTP 404
      updatePriceData = await this.pythConnection.getPriceUpdatesAtTimestamp(
        expiry,
        [pythPriceFeedId],
        {},
      );
    }
    return updatePriceData;
  }

  async _getTradingPairOfVault(
    linkedToken: ethers.Contract,
    investmentToken: ethers.Contract,
    isBuyLow: boolean,
  ) {
    this.provider.isMulticallEnabled = true;
    const [linkedTokenName, investmentTokenName] = await Promise.all([
      linkedToken.symbol(),
      investmentToken.symbol(),
    ]);
    this.provider.isMulticallEnabled = false;

    return isBuyLow
      ? `${linkedTokenName}-${investmentTokenName}`
      : `${investmentTokenName}-${linkedTokenName}`;
  }

  /**
   * Check if a vault uses collateral pool
   * Version format: series version in hundreds place, minor version in ones place
   * e.g., 208 = series 2.8, 8 = series 0.8 (actually series 1)
   * Series 2+ vaults always use collateral pool and don't have useCollateralPool() method
   * @param vault - The vault contract
   * @param versionRaw - Optional pre-fetched version number to avoid redundant calls (can be BigInt or number)
   */
  private async _checkUseCollateralPool(
    vault: ethers.Contract,
    versionRaw?: number | bigint,
  ): Promise<boolean> {
    // If version is not provided, fetch it
    if (versionRaw === undefined) {
      versionRaw = await vault.version();
    }

    // Convert BigInt to number if needed
    const version = Number(versionRaw);
    const seriesVersion = Math.floor(version / 100);

    if (seriesVersion >= 2) {
      // Series 2+ vaults always use collateral pool
      return true;
    }

    // For series 1 or older versions, check useCollateralPool() method
    try {
      return await vault.useCollateralPool();
    } catch {
      // If the method doesn't exist, assume it doesn't use collateral pool
      return false;
    }
  }

  private async _getV2UserWithdrawAmount(
    vaultAddress: string,
    userAddress: string,
    state: bigint | number,
  ): Promise<bigint> {
    const pool = new ethers.Contract(
      this.config.collateralPoolV2,
      CollateralPoolV2ABI,
      this.signer,
    );
    const ub = await pool.userVaultBalance(vaultAddress, userAddress);
    const isSwapped = Number(state) === 1;
    return isSwapped
      ? BigInt(ub.linkedTokenTotal)
      : BigInt(ub.investmentTokenYield) + BigInt(ub.principal);
  }

  async createVault(createVaultOptions) {
    const isBuyLow = !!createVaultOptions.isBuyLow;
    const useCollateralPool = !!createVaultOptions.useCollateralPool;
    const tradingPair = createVaultOptions.tradingPair;
    const useNativeToken = !!createVaultOptions.useNativeToken;
    const vaultSeriesVersion = createVaultOptions.vaultSeriesVersion || 1;

    if (vaultSeriesVersion === 1 && createVaultOptions.signer) {
      throw new Error(
        "Custom signer is not supported for vault series version 1",
      );
    }

    this._checkTradingPairSettings(tradingPair);

    const factory = new ethers.Contract(
      this.config.factory,
      FactoryABI,
      this.signer,
    );

    const baseTokenAddress = this.config.tradingPairs[tradingPair].baseToken;
    const quoteTokenAddress = this.config.tradingPairs[tradingPair].quoteToken;
    const baseToken = await this._getToken(baseTokenAddress);
    const quoteToken = await this._getToken(quoteTokenAddress);
    const linkedToken = isBuyLow ? baseToken : quoteToken;
    const investmentToken = isBuyLow ? quoteToken : baseToken;

    this.provider.isMulticallEnabled = true;
    const [baseTokenDecimals, quoteTokenDecimals] = await Promise.all([
      baseToken.decimals(),
      quoteToken.decimals(),
    ]);
    this.provider.isMulticallEnabled = false;

    const priceFeedDecimals = Number(
      this.config.tradingPairs[tradingPair].priceFeed.decimals,
    );

    const investmentTokenDecimals = isBuyLow
      ? quoteTokenDecimals
      : baseTokenDecimals;
    const linkedPriceDecimals =
      BigInt(fixDecimals) +
      BigInt(quoteTokenDecimals) -
      BigInt(baseTokenDecimals);

    const ownerAddress = await this._getSignerAddress();
    const vaultParams: CreateVaultParamsStruct = {
      owner: ownerAddress,
      baseToken: baseTokenAddress,
      quoteToken: quoteTokenAddress,
      expiry: createVaultOptions.expiry,
      linkedOraclePrice: parseUnits(
        createVaultOptions.linkedPrice,
        priceFeedDecimals,
      ).toString(),
      yieldValue: parseUnits(
        createVaultOptions.yieldPercentage,
        fixDecimals - 2,
      ).toString(),
      isBuyLow: isBuyLow,
      quantity: parseUnits(
        createVaultOptions.quantity,
        investmentTokenDecimals,
      ).toString(),
      useCollateralPool: useCollateralPool,
      vaultSeriesVersion: vaultSeriesVersion,
      useNativeToken: useNativeToken,
      signer: createVaultOptions.signer || ownerAddress,
    };
    // Prepare for trading fee
    const linkedPriceBN = parseUnits(
      createVaultOptions.linkedPrice,
      linkedPriceDecimals,
    );
    const yieldValueBN = BigInt(vaultParams.yieldValue);
    const quantityBN = BigInt(vaultParams.quantity);

    const tradingFeeRateBN = (await factory.getPresetFeeParams())
      .tradingFeeRate;

    const pythPriceFeed = new ethers.Contract(
      this.config.pythPriceFeed,
      IPythABI,
      this.signer,
    );

    // Get data from price feed
    // NOTE: a dirty hack - we use a future time to get the latest price
    const updatePriceData = await this._getHermesPriceUpdateAtTimestamp(
      Date.now() / 1000 + 86400,
      tradingPair,
    );
    const updateData = updatePriceData && updatePriceData.binary.data;
    const binaryData = [updateData && Buffer.from(updateData[0], "hex")];

    // FIXME: any fractional amount could be converted to 1
    // In this case, we ask the LP to approve more than it requires.
    // Future works: we should derive a more accurate value.
    const priceRate = Math.ceil(
      parseFloat(updatePriceData.parsed[0].ema_price.price) /
        Math.pow(10, priceFeedDecimals),
    );
    const oraclePriceAtCreationBN = parseUnits(
      priceRate.toString(),
      linkedPriceDecimals,
    );

    // Approve spending
    if (!useCollateralPool) {
      const { linkedTokenAmount, investmentTokenAmount } =
        calculateTokenAmounts(
          quantityBN,
          yieldValueBN,
          isBuyLow,
          tradingFeeRateBN,
          oraclePriceAtCreationBN,
          linkedPriceBN,
        );

      const linkedTokenApproval = this._approveERC20(
        linkedToken,
        this.config.factory,
        linkedTokenAmount.toString(),
      );
      const investmentTokenApproval = this._approveERC20(
        investmentToken,
        this.config.factory,
        investmentTokenAmount.toString(),
      );

      await Promise.all([linkedTokenApproval, investmentTokenApproval]);
    }

    const updateFee = await pythPriceFeed.getUpdateFee(binaryData);

    await this._simulateTransaction(() =>
      factory.createVault.staticCall(vaultParams, binaryData, {
        value: updateFee,
        gasLimit: 3000000,
      }),
    );

    const result: ContractTransactionReceipt =
      await this._sendContractTxAndWait({
        contract: factory,
        functionName: "createVault",
        functionArgs: [vaultParams, binaryData],
        overrides: {
          value: updateFee,
          gasLimit: 3000000,
        },
      });

    // Get vault address from event logs
    if (result.status == 1) {
      console.log("Vault created successfully");

      let parsedLog = null;
      for (const log of result.logs) {
        try {
          const parsed = factory.interface.parseLog({
            topics: log.topics as string[],
            data: log.data,
          });
          if (parsed && parsed.name === "VaultCreated") {
            parsedLog = parsed;
            break;
          }
        } catch {
          // Not a matching event, continue
        }
      }
      if (!parsedLog) {
        throw new Error("Vault creation event not found");
      }
      const vaultAddress = parsedLog.args.vaultAddress;
      console.log(`Vault address: ${vaultAddress}`);

      if (useCollateralPool && vaultSeriesVersion === 1) {
        console.log(
          "Waiting for blockchain state to settle before CollateralPool approval...",
        );
        await new Promise((resolve) => setTimeout(resolve, 3000));
        console.log(`Processing CollateralPool Approval for: ${vaultAddress}:`);
        const collateralPool = new ethers.Contract(
          this.config.collateralPool,
          CollateralPoolABI,
          this.signer,
        );

        // Retry CollateralPool approval
        for (let attempt = 1; attempt <= 3; attempt++) {
          try {
            await this._simulateTransaction(() =>
              collateralPool.approveVault.staticCall(vaultAddress, true),
            );

            const result: ContractTransactionReceipt =
              await this._sendContractTxAndWait({
                contract: collateralPool,
                functionName: "approveVault",
                functionArgs: [vaultAddress, true],
              });
            if (result.status !== 1) {
              throw new Error("CollateralPool approval failed");
            }
            console.log("CollateralPool approval succeeded!");
            break;
          } catch (retryError) {
            if (attempt === 3) throw retryError;

            console.log(
              `Attempt ${attempt + 1} failed, retrying in 2 seconds...`,
            );
            await new Promise((resolve) => setTimeout(resolve, 2000));
          }
        }
      }
    }
  }

  async adjustVaultYield(vaultAddress: string, yieldPercentage: string) {
    const yieldValue = parseUnits(yieldPercentage, fixDecimals - 2).toString();
    const vault = new ethers.Contract(vaultAddress, VaultABI, this.signer);
    const currentYieldValue = await vault.yieldValue();

    if (BigInt(currentYieldValue) === BigInt(yieldValue)) {
      console.error(
        `Error: Vault ${vaultAddress} already has yield ${yieldPercentage}%.`,
      );
      return;
    }

    const useCollateralPool = await this._checkUseCollateralPool(vault);

    if (!useCollateralPool) {
      this.provider.isMulticallEnabled = true;
      const [
        isBuyLow,
        linkedTokenAddress,
        investmentTokenAddress,
        quantityRaw,
        depositTotalRaw,
        linkedPriceRaw,
        currentYieldValueRaw,
        tradingFeeRateRaw,
        oraclePriceAtCreationRaw,
      ] = await Promise.all([
        vault.isBuyLow(),
        vault.linkedToken(),
        vault.investmentToken(),
        vault.quantity(),
        vault.depositTotal(),
        vault.linkedPrice(),
        vault.yieldValue(),
        vault.tradingFeeRate(),
        vault.oraclePriceAtCreation(),
      ]);
      this.provider.isMulticallEnabled = false;

      const quantity = BigInt(quantityRaw);
      const depositTotal = BigInt(depositTotalRaw);
      const linkedPrice = BigInt(linkedPriceRaw);
      const currentYieldValue = BigInt(currentYieldValueRaw);
      const tradingFeeRate = BigInt(tradingFeeRateRaw);
      const oraclePriceAtCreation = BigInt(oraclePriceAtCreationRaw);

      const ownerDepositLinkedTokenAmount = BigInt(
        await vault.ownerDepositLinkedTokenAmount(),
      );
      const ownerDepositInvestmentTokenAmount = BigInt(
        await vault.ownerDepositInvestmentTokenAmount(),
      );

      const {
        linkedTokenAmount: currentDepositLinkedTokenAmount,
        investmentTokenAmount: currentDepositInvestmentTokenAmount,
      } = calculateTokenAmounts(
        depositTotal,
        currentYieldValue,
        isBuyLow,
        tradingFeeRate,
        oraclePriceAtCreation,
        linkedPrice,
      );
      const {
        linkedTokenAmount: remainingDepositLinkedTokenAmount,
        investmentTokenAmount: remainingDepositInvestmentTokenAmount,
      } = calculateTokenAmounts(
        quantity - depositTotal,
        BigInt(yieldValue),
        isBuyLow,
        tradingFeeRate,
        oraclePriceAtCreation,
        linkedPrice,
      );
      const newOwnerDepositLinkedTokenAmount =
        currentDepositLinkedTokenAmount + remainingDepositLinkedTokenAmount;
      const newOwnerDepositInvestmentTokenAmount =
        currentDepositInvestmentTokenAmount +
        remainingDepositInvestmentTokenAmount;

      // approve the difference
      if (newOwnerDepositLinkedTokenAmount > ownerDepositLinkedTokenAmount) {
        const linkedToken = await this._getToken(linkedTokenAddress);
        await this._approveERC20(
          linkedToken,
          vaultAddress,
          (
            newOwnerDepositLinkedTokenAmount - ownerDepositLinkedTokenAmount
          ).toString(),
        );
      }
      if (
        newOwnerDepositInvestmentTokenAmount > ownerDepositInvestmentTokenAmount
      ) {
        const investmentToken = await this._getToken(investmentTokenAddress);
        await this._approveERC20(
          investmentToken,
          vaultAddress,
          (
            newOwnerDepositInvestmentTokenAmount -
            ownerDepositInvestmentTokenAmount
          ).toString(),
        );
      }
    }

    try {
      await this._simulateTransaction(() =>
        vault.adjustYieldValue.staticCall(yieldValue),
      );

      const result: ContractTransactionReceipt =
        await this._sendContractTxAndWait({
          contract: vault,
          functionName: "adjustYieldValue",
          functionArgs: [yieldValue],
        });
      if (result.status == 1) {
        console.log(
          `Vault ${vaultAddress} yield adjusted to ${yieldPercentage}% successfully`,
        );
      } else {
        console.error(`Vault ${vaultAddress} yield adjust failed`);
      }
    } catch (error) {
      console.error(`Vault ${vaultAddress} yield adjust failed`);
      console.error((error as EthersError).shortMessage);
    }
  }

  async approveVault(vaultAddress: string, approve: boolean) {
    const vault = new ethers.Contract(vaultAddress, VaultABI, this.signer);

    try {
      const versionRaw = await vault.version();
      const version = Number(versionRaw);
      const seriesVersion = Math.floor(version / 100);

      const useCollateralPool = await this._checkUseCollateralPool(
        vault,
        version,
      );

      if (!useCollateralPool) {
        console.error(`Vault ${vaultAddress} is not using collateral pool`);
        return;
      }

      // Select collateral pool address based on series version
      const collateralPoolAddress =
        seriesVersion >= 2
          ? this.config.collateralPoolV2
          : this.config.collateralPool;

      const collateralPool = new ethers.Contract(
        collateralPoolAddress,
        CollateralPoolABI,
        this.signer,
      );

      await this._simulateTransaction(() =>
        collateralPool.approveVault.staticCall(vaultAddress, approve),
      );

      const result: ContractTransactionReceipt =
        await this._sendContractTxAndWait({
          contract: collateralPool,
          functionName: "approveVault",
          functionArgs: [vaultAddress, approve],
        });
      if (result.status == 1) {
        console.log(
          `CollateralPool ${approve ? "approval" : "disapproval"} for vault ${vaultAddress} succeeded!`,
        );
      } else {
        console.error(
          `CollateralPool ${approve ? "approval" : "disapproval"} for vault ${vaultAddress} failed!`,
        );
      }
    } catch (error) {
      console.error(
        `CollateralPool ${approve ? "approval" : "disapproval"} for vault ${vaultAddress} failed!`,
      );
      console.error((error as EthersError).shortMessage);
    }
  }

  async cancelVault(vaultAddress: string) {
    const vault = new ethers.Contract(vaultAddress, VaultABI, this.signer);

    try {
      await this._simulateTransaction(() => vault.lpCancel.staticCall());

      const result: ContractTransactionReceipt =
        await this._sendContractTxAndWait({
          contract: vault,
          functionName: "lpCancel",
          functionArgs: [],
        });

      if (result.status == 1) {
        console.log(`Vault ${vaultAddress} cancelled successfully`);
      } else {
        console.error(`Vault ${vaultAddress} cancelled failed`);
      }
    } catch (error) {
      console.error(`Vault ${vaultAddress} cancelled failed`);
      console.error((error as EthersError).shortMessage);
    }
  }

  async subscribeVault(
    vaultAddress: string,
    amount: string,
    signatureOptions?: SubscribeVaultSignatureOptions,
  ) {
    const signature = signatureOptions?.signature?.trim();
    const signedDeposit = !!signature;

    let signedYieldValue: string | undefined;
    let nonce: string | undefined;
    let deadline: string | undefined;
    if (signedDeposit) {
      signedYieldValue = signatureOptions?.signedYieldValue?.trim();
      nonce = signatureOptions?.nonce?.trim();
      deadline = signatureOptions?.deadline?.trim();

      if (!signedYieldValue || !nonce || !deadline) {
        throw new Error(
          "--signedYieldValue, --nonce and --deadline are required when --signature is provided",
        );
      }
      if (!/^\d+$/.test(signedYieldValue)) {
        throw new Error("--signedYieldValue must be a non-negative integer");
      }
      if (!/^\d+$/.test(nonce)) {
        throw new Error("--nonce must be a non-negative integer");
      }
      if (!/^\d+$/.test(deadline)) {
        throw new Error("--deadline must be a non-negative integer");
      }
      if (
        !/^0x[0-9a-fA-F]+$/.test(signature) ||
        (signature.length - 2) % 2 !== 0
      ) {
        throw new Error("--signature must be a valid hex string");
      }
    }

    const vault = new ethers.Contract(vaultAddress, VaultCore, this.signer);
    this.provider.isMulticallEnabled = true;
    const [isBuyLow, investmentTokenAddress, linkedTokenAddress] =
      await Promise.all([
        vault.isBuyLow(),
        vault.investmentToken(),
        vault.linkedToken(),
      ]);
    this.provider.isMulticallEnabled = false;

    const linkedToken = await this._getToken(linkedTokenAddress);
    const investmentToken = await this._getToken(investmentTokenAddress);

    const investmentTokenDecimals = await investmentToken.decimals();
    const subscribeAmount = parseUnits(
      amount,
      investmentTokenDecimals,
    ).toString();
    await this._approveERC20(
      investmentToken,
      this.config.router,
      subscribeAmount,
    );

    // Get data from price feed
    const tradingPair = await this._getTradingPairOfVault(
      linkedToken,
      investmentToken,
      isBuyLow,
    );
    const updatePriceData = await this._getHermesPriceUpdateAtTimestamp(
      Date.now() / 1000 + 86400,
      tradingPair,
    );
    const pythPriceFeed = new ethers.Contract(
      this.config.pythPriceFeed,
      IPythABI,
      this.signer,
    );
    const updateData = updatePriceData && updatePriceData.binary.data;
    const binaryData = [updateData && Buffer.from(updateData[0], "hex")];
    const updateFee = await pythPriceFeed.getUpdateFee(binaryData);
    const minYieldValue = !!vault.minYieldValue || 0;

    try {
      const router = new ethers.Contract(
        this.config.router,
        RouterABI,
        this.signer,
      );

      if (signedDeposit) {
        await this._simulateTransaction(() =>
          router.deposit.staticCall(
            vaultAddress,
            subscribeAmount,
            signedYieldValue,
            nonce,
            deadline,
            signature,
            minYieldValue,
            binaryData,
            { value: updateFee },
          ),
        );

        const result = await this._sendContractTxAndWait({
          contract: router,
          functionName: "deposit",
          functionArgs: [
            vaultAddress,
            subscribeAmount,
            signedYieldValue,
            nonce,
            deadline,
            signature,
            minYieldValue,
            binaryData,
          ],
          overrides: { value: updateFee },
        });

        if (result.status == 1) {
          console.log(`Vault ${vaultAddress} subscribed successfully`);
        } else {
          console.error(`Vault ${vaultAddress} subscribed failed`);
        }
        return;
      }

      await this._simulateTransaction(() =>
        router.deposit.staticCall(
          vaultAddress,
          subscribeAmount,
          minYieldValue,
          binaryData,
          { value: updateFee },
        ),
      );

      const result = await this._sendContractTxAndWait({
        contract: router,
        functionName: "deposit",
        functionArgs: [
          vaultAddress,
          subscribeAmount,
          minYieldValue,
          binaryData,
        ],
        overrides: { value: updateFee },
      });

      if (result.status == 1) {
        console.log(`Vault ${vaultAddress} subscribed successfully`);
      } else {
        console.error(`Vault ${vaultAddress} subscribed failed`);
      }
    } catch (error) {
      console.error(`Vault ${vaultAddress} subscribed failed`);
      console.error((error as EthersError).shortMessage);
    }
  }

  async withdrawVault(vaultAddress: string, checkOwner = false) {
    const account = await this._getSignerAddress();
    const vault = new ethers.Contract(vaultAddress, VaultABI, this.signer);

    this.provider.isMulticallEnabled = true;
    const [
      owner,
      expiry,
      withdrawalUnlockTimeRaw,
      isBuyLow,
      state,
      investmentTokenAddress,
      linkedTokenAddress,
      versionRaw,
    ] = await Promise.all([
      vault.owner(),
      vault.expiry(),
      vault.withdrawalUnlockTime().catch(() => null),
      vault.isBuyLow(),
      vault.state(),
      vault.investmentToken(),
      vault.linkedToken(),
      vault.version().catch(() => null),
    ]);
    this.provider.isMulticallEnabled = false;

    // Older vaults fall back to expiry time and set 0 as version
    const withdrawalUnlockTime = withdrawalUnlockTimeRaw ?? expiry;
    const seriesVersion = Math.floor(Number(versionRaw ?? 0) / 100);

    console.log(`Withdrawing vault ${vaultAddress}...`);
    if (Date.now() < Number(withdrawalUnlockTime) * 1000) {
      console.error(
        `Vault ${vaultAddress} is not yet available for withdrawal`,
      );
      return;
    }

    if (checkOwner && owner !== account) {
      console.error(
        `Account ${account} is not the owner of the vault ${vaultAddress}`,
      );
      return;
    } else if (!checkOwner && owner === account) {
      console.error(
        `Account ${account} is the owner of the vault ${vaultAddress}`,
      );
      return;
    }

    const linkedToken = await this._getToken(linkedTokenAddress);
    const investmentToken = await this._getToken(investmentTokenAddress);
    const tradingPair = await this._getTradingPairOfVault(
      linkedToken,
      investmentToken,
      isBuyLow,
    );
    const updatePriceData = await this._getHermesPriceUpdateAtTimestamp(
      expiry,
      tradingPair,
    );
    const pythPriceFeed = new ethers.Contract(
      this.config.pythPriceFeed,
      IPythABI,
      this.signer,
    );
    const updateData = updatePriceData && updatePriceData.binary.data;
    const binaryData = [updateData && Buffer.from(updateData[0], "hex")];
    const updateFee = await pythPriceFeed.getUpdateFee(binaryData);
    const getPriceOptions = {
      pythPublishTime: expiry,
      pythMinConfidenceRatio: 0,
      chainlinkUseLatestAnswer: false, // not used
      chainlinkRoundId: 0, // not used
    };

    let result = null;
    try {
      if (owner === account) {
        if (seriesVersion >= 2) {
          // V2 vaults do not support LP withdrawal
          console.error(
            `V2 Vault ${vaultAddress} does not support LP withdrawal`,
          );
          return;
        }
        if (state == 1) {
          // Check investment token balance in the vault, if it's 0, then LP has withdrawn the vault
          const investmentTokenBalance =
            await investmentToken.balanceOf(vaultAddress);
          if (BigInt(investmentTokenBalance) == zeroBigNumber) {
            console.error(
              `LP has been withdrawn from the vault ${vaultAddress}`,
            );
            return;
          }
        } else if (state == 2) {
          // Check linked token balance in the vault, if it's 0, then LP has withdrawn the vault
          const linkedTokenBalance = await linkedToken.balanceOf(vaultAddress);
          if (BigInt(linkedTokenBalance) == zeroBigNumber) {
            console.error(
              `LP has been withdrawn from the vault ${vaultAddress}`,
            );
            return;
          }
        }

        await this._simulateTransaction(() =>
          vault.lpWithdraw.staticCall(binaryData, getPriceOptions, {
            value: updateFee,
          }),
        );

        result = await this._sendContractTxAndWait({
          contract: vault,
          functionName: "lpWithdraw",
          functionArgs: [binaryData, getPriceOptions],
          overrides: { value: updateFee },
        });
      } else {
        // Check subscriber balances in CollateralPoolV2
        if (seriesVersion >= 2) {
          const withdrawAmount = await this._getV2UserWithdrawAmount(
            vaultAddress,
            account,
            state,
          );
          if (withdrawAmount == zeroBigNumber) {
            console.error(
              `Account ${account} has already withdrawn the vault ${vaultAddress}`,
            );
            return;
          }
        } else {
          const balances = await vault.balances(account);
          if (BigInt(balances) == zeroBigNumber) {
            console.error(
              `Account ${account} has no balance in the vault ${vaultAddress}`,
            );
            return;
          }
        }

        await this._simulateTransaction(() =>
          vault.withdraw.staticCall(binaryData, getPriceOptions, {
            value: updateFee,
          }),
        );

        result = await this._sendContractTxAndWait({
          contract: vault,
          functionName: "withdraw",
          functionArgs: [binaryData, getPriceOptions],
          overrides: { value: updateFee },
        });
      }

      if (result.status == 1) {
        console.log(
          `Vault ${vaultAddress} withdrawn successfully by the ${owner === account ? "LP" : "subscriber"}`,
        );
      } else {
        console.error(
          `Vault ${vaultAddress} withdrawn failed by the ${owner === account ? "LP" : "subscriber"}`,
        );
      }
    } catch (error) {
      console.error(
        `Vault ${vaultAddress} withdrawn failed by the ${owner === account ? "LP" : "subscriber"}`,
      );
      console.error((error as EthersError).shortMessage);
    }
  }

  async groupVaultsByTradingPairAndExpiry(vaultData: VaultData[]) {
    const results = vaultData.map((vault) => {
      return {
        vault,
        key: `${vault.tradingPair}-${vault.expiry}${vault.isLp ? "-lp" : "-subscriber"}`,
        tradingPair: vault.tradingPair,
        expiry: vault.expiry,
        isLp: vault.isLp,
      };
    });

    // Group results
    const grouped: {
      [key: string]: {
        vaults: VaultData[];
        tradingPair: string;
        expiry: string;
        isLp: boolean;
      };
    } = {};
    results.forEach(({ vault, key, tradingPair, expiry, isLp }) => {
      if (!grouped[key]) {
        grouped[key] = {
          vaults: [],
          tradingPair,
          expiry,
          isLp,
        };
      }
      grouped[key].vaults.push(vault);
    });

    Object.keys(grouped).forEach((key) => {
      console.log(
        `Grouped ${grouped[key].vaults.length} vaults for ${grouped[key].tradingPair} at expiry ${grouped[key].expiry}`,
      );
    });
    return grouped;
  }

  async withdrawMultipleVaults(
    vaultAddresses: string[],
    checkOwner = false,
    bypassCheck = false,
  ) {
    console.log(
      `Start processing vaults withdrawal for ${checkOwner ? "LP" : "subscriber"}...`,
    );
    const vaultBatchManager = new ethers.Contract(
      this.config.vaultBatchManager,
      VaultBatchManagerABI,
      this.signer,
    );
    const pythPriceFeed = new ethers.Contract(
      this.config.pythPriceFeed,
      IPythABI,
      this.signer,
    );

    // Process vault withdrawal
    const processVaultGroup = async (
      vaults: string[],
      tradingPair: string,
      expiry: string,
      isLp: boolean,
    ) => {
      try {
        console.log(
          `Processing ${vaults.length} vaults for ${tradingPair} at expiry ${expiry}`,
        );
        const updatePriceData = await this._getHermesPriceUpdateAtTimestamp(
          parseInt(expiry.toString()),
          tradingPair,
        );

        const updateData = updatePriceData && updatePriceData.binary.data;
        const binaryData = [updateData && Buffer.from(updateData[0], "hex")];
        const singleUpdateFee = await pythPriceFeed.getUpdateFee(binaryData);
        const totalUpdateFee = BigInt(singleUpdateFee) * BigInt(vaults.length);
        console.log(
          `Single update fee: ${singleUpdateFee}, total update fee: ${totalUpdateFee}`,
        );

        const getPriceOptions = {
          pythPublishTime: parseInt(expiry),
          pythMinConfidenceRatio: 0,
          chainlinkUseLatestAnswer: false, // not used
          chainlinkRoundId: 0, // not used
        };

        let result = null;
        try {
          if (isLp) {
            await this._simulateTransaction(() =>
              vaultBatchManager.lpWithdrawVaults.staticCall(
                vaults,
                binaryData,
                getPriceOptions,
                {
                  value: totalUpdateFee,
                },
              ),
            );

            result = await this._sendContractTxAndWait({
              contract: vaultBatchManager,
              functionName: "lpWithdrawVaults",
              functionArgs: [vaults, binaryData, getPriceOptions],
              overrides: { value: totalUpdateFee },
            });
          } else {
            await this._simulateTransaction(() =>
              vaultBatchManager.withdrawVaults.staticCall(
                vaults,
                binaryData,
                getPriceOptions,
                {
                  value: totalUpdateFee,
                },
              ),
            );

            result = await this._sendContractTxAndWait({
              contract: vaultBatchManager,
              functionName: "withdrawVaults",
              functionArgs: [vaults, binaryData, getPriceOptions],
              overrides: { value: totalUpdateFee },
            });
          }
          console.log(
            `Successfully withdrawn vaults, tx hash: ${result.hash}, vault addresses: ${vaults}`,
          );
          return true;
        } catch (error) {
          console.error(
            `Failed to withdraw vaults, vault addresses: ${vaults}`,
          );
          console.error((error as EthersError).shortMessage);
          return false;
        }
      } catch (error) {
        console.error(`Error processing vaults: ${error}`);
        return false;
      }
    };

    // If bypassCheck is true, directly process all vaults
    if (bypassCheck) {
      console.log(
        "Bypassing checks and grouping, processing all vaults together...",
      );

      // Get first vault info as reference using multicall
      const firstVault = new ethers.Contract(
        vaultAddresses[0],
        VaultABI,
        this.signer,
      );
      const account = await this._getSignerAddress();

      this.provider.isMulticallEnabled = true;
      const [
        expiry,
        owner,
        investmentTokenAddress,
        linkedTokenAddress,
        isBuyLow,
      ] = await Promise.all([
        firstVault.expiry(),
        firstVault.owner(),
        firstVault.investmentToken(),
        firstVault.linkedToken(),
        firstVault.isBuyLow(),
      ]);
      this.provider.isMulticallEnabled = false;

      const isLp = owner === account;
      const investmentToken = await this._getToken(investmentTokenAddress);
      const linkedToken = await this._getToken(linkedTokenAddress);
      const tradingPair = await this._getTradingPairOfVault(
        linkedToken,
        investmentToken,
        isBuyLow,
      );

      // Directly process all vaults
      await processVaultGroup(vaultAddresses, tradingPair, expiry, isLp);
      return;
    }

    // Check and filter vaults that are not yet available for withdrawal using multicall
    const filteredVaultData: VaultData[] = [];
    const account = await this._getSignerAddress();

    // Batch collect basic vault data using multicall
    const vaultContracts = vaultAddresses.map(
      (address) => new ethers.Contract(address, VaultABI, this.signer),
    );

    this.provider.isMulticallEnabled = true;
    const basicVaultData = await Promise.all(
      vaultContracts.map(async (vault) => {
        const [
          expiry,
          withdrawalUnlockTimeRaw,
          owner,
          investmentTokenAddress,
          linkedTokenAddress,
          isBuyLow,
          state,
          versionRaw,
          depositTotalRaw,
        ] = await Promise.all([
          vault.expiry(),
          vault.withdrawalUnlockTime().catch(() => null),
          vault.owner(),
          vault.investmentToken(),
          vault.linkedToken(),
          vault.isBuyLow(),
          vault.state(),
          vault.version().catch(() => null),
          vault.depositTotal(),
        ]);

        // Older vaults fall back to expiry time and set 0 as version
        const withdrawalUnlockTime = withdrawalUnlockTimeRaw ?? expiry;
        const version = versionRaw ?? 0;

        // Determine useCollateralPool based on version
        const useCollateralPool = await this._checkUseCollateralPool(
          vault,
          version,
        );

        return {
          address: vault.target,
          expiry,
          withdrawalUnlockTime,
          owner,
          investmentTokenAddress,
          linkedTokenAddress,
          isBuyLow,
          state,
          seriesVersion: Math.floor(Number(version) / 100),
          useCollateralPool,
          depositTotalRaw,
        };
      }),
    );
    this.provider.isMulticallEnabled = false;

    // Process each vault with collected data
    for (let i = 0; i < vaultAddresses.length; i++) {
      const vaultAddress = vaultAddresses[i];
      const vaultData = basicVaultData[i];
      const vault = vaultContracts[i];

      if (Date.now() < Number(vaultData.withdrawalUnlockTime) * 1000) {
        console.error(
          `Skip vault ${vaultAddress}: vault is not yet available for withdrawal`,
        );
        continue;
      }

      if (checkOwner && vaultData.owner !== account) {
        console.error(
          `Skip vault ${vaultAddress}: account ${account} is not the owner of the vault`,
        );
        continue;
      } else if (!checkOwner && vaultData.owner === account) {
        console.error(
          `Skip vault ${vaultAddress}: account ${account} is the owner of the vault`,
        );
        continue;
      }

      const investmentToken = await this._getToken(
        vaultData.investmentTokenAddress,
      );
      const linkedToken = await this._getToken(vaultData.linkedTokenAddress);
      const tradingPair = await this._getTradingPairOfVault(
        linkedToken,
        investmentToken,
        vaultData.isBuyLow,
      );
      const isLp = vaultData.owner === account;
      if (isLp) {
        if (vaultData.seriesVersion >= 2) {
          // V2 vaults do not support LP withdrawal
          console.error(
            `Skip vault ${vaultAddress}: V2 vault does not support LP withdrawal`,
          );
          continue;
        }
        const depositTotal = BigInt(vaultData.depositTotalRaw);
        // If the vault is using collateral pool and no user deposit, then there's no locked vault for the lp to withdraw
        if (vaultData.useCollateralPool && depositTotal == zeroBigNumber) {
          console.error(
            `Skip vault ${vaultAddress}: no user deposit in the vault and the vault is using collateral pool`,
          );
          continue;
        }
        if (vaultData.state == 1) {
          const investmentTokenBalance =
            await investmentToken.balanceOf(vaultAddress);

          if (BigInt(investmentTokenBalance) == zeroBigNumber) {
            console.error(
              `Skip vault ${vaultAddress}: LP has been withdrawn from the vault`,
            );
            continue;
          }
        } else if (vaultData.state == 2) {
          const linkedTokenBalance = await linkedToken.balanceOf(vaultAddress);
          if (BigInt(linkedTokenBalance) == zeroBigNumber) {
            console.error(
              `Skip vault ${vaultAddress}: LP has been withdrawn from the vault`,
            );
            continue;
          }
        }
      } else {
        // Check subscriber balances in CollateralPoolV2
        if (vaultData.seriesVersion >= 2) {
          const withdrawAmount = await this._getV2UserWithdrawAmount(
            vaultAddress,
            account,
            vaultData.state,
          );
          if (withdrawAmount == zeroBigNumber) {
            console.error(
              `Skip vault ${vaultAddress}: Subscriber ${account} has already withdrawn the vault`,
            );
            continue;
          }
        } else {
          const balances = await vault.balances(account);
          if (BigInt(balances) == zeroBigNumber) {
            console.error(
              `Skip vault ${vaultAddress}: Subscriber ${account} has no balance in the vault`,
            );
            continue;
          }
        }
      }

      filteredVaultData.push({
        vault_address: vaultAddress,
        tradingPair,
        expiry: vaultData.expiry,
        isLp,
      });
    }

    const vaultsByPairAndExpiry =
      await this.groupVaultsByTradingPairAndExpiry(filteredVaultData);

    // Process each trading pair-expiry group
    for (const [groupKey, group] of Object.entries(vaultsByPairAndExpiry)) {
      console.log("=".repeat(100));
      console.log(
        `Processing group: ${groupKey} (${group.vaults.length} vaults)`,
      );
      console.log(
        `Vault addresses: ${JSON.stringify(group.vaults.map((v) => v.vault_address))}`,
      );

      await processVaultGroup(
        group.vaults.map((v) => v.vault_address),
        group.tradingPair,
        group.expiry,
        group.isLp,
      );
    }
  }

  async cancelMultipleVaults(vaultAddresses: string[], bypassCheck = false) {
    console.log("Start processing vaults cancellation for LP...");
    const vaultBatchManager = new ethers.Contract(
      this.config.vaultBatchManager,
      VaultBatchManagerABI,
      this.signer,
    );

    // If bypassCheck is true, directly cancel all vaults
    if (bypassCheck) {
      console.log(
        "Bypassing checks, directly cancelling all vaults together...",
      );

      try {
        await this._simulateTransaction(() =>
          vaultBatchManager.lpCancelVaults.staticCall(vaultAddresses),
        );

        const result = await this._sendContractTxAndWait({
          contract: vaultBatchManager,
          functionName: "lpCancelVaults",
          functionArgs: [vaultAddresses],
        });

        if (result.status == 1) {
          console.log(
            `Successfully cancelled vaults, tx hash: ${result.hash}, vault addresses: ${vaultAddresses}`,
          );
        } else {
          console.error(
            `Failed to cancel vaults, vault addresses: ${vaultAddresses}`,
          );
        }
      } catch (error) {
        console.error(
          `Failed to cancel vaults, vault addresses: ${vaultAddresses}`,
        );
        console.error((error as EthersError).shortMessage);
      }
      return;
    }

    // Check and filter vaults that can be cancelled
    const filteredVaultAddresses: string[] = [];
    const account = await this._getSignerAddress();

    // Batch collect basic vault data using multicall
    const vaultContracts = vaultAddresses.map(
      (address) => new ethers.Contract(address, VaultABI, this.signer),
    );

    this.provider.isMulticallEnabled = true;
    const basicVaultData = await Promise.all(
      vaultContracts.map(async (vault) => {
        const [owner, state, depositDeadline, lpCancelled] = await Promise.all([
          vault.owner(),
          vault.state(),
          vault.depositDeadline(),
          vault.lpCancelled(),
        ]);
        return {
          owner,
          state,
          depositDeadline,
          lpCancelled,
        };
      }),
    );
    this.provider.isMulticallEnabled = false;

    // Process each vault with collected data
    for (let i = 0; i < vaultAddresses.length; i++) {
      const vaultAddress = vaultAddresses[i];
      const vaultData = basicVaultData[i];

      // Check if the current account is the owner
      if (vaultData.owner !== account) {
        console.error(
          `Skip vault ${vaultAddress}: account ${account} is not the owner of the vault`,
        );
        continue;
      }

      // Check if vault is already cancelled
      if (vaultData.lpCancelled) {
        console.error(`Skip vault ${vaultAddress}: vault is already cancelled`);
        continue;
      }

      // Check if vault has been executed (state != 0)
      if (vaultData.state != 0) {
        console.error(
          `Skip vault ${vaultAddress}: vault has been executed and cannot be cancelled`,
        );
        continue;
      }

      // Check if vault has expired
      if (Date.now() >= Number(vaultData.depositDeadline) * 1000) {
        console.error(
          `Skip vault ${vaultAddress}: vault has expired and cannot be cancelled`,
        );
        continue;
      }

      filteredVaultAddresses.push(vaultAddress);
    }

    if (filteredVaultAddresses.length === 0) {
      console.log("No vaults to cancel after filtering.");
      return;
    }

    console.log(
      `Processing cancellation for ${filteredVaultAddresses.length} vaults: ${filteredVaultAddresses}`,
    );

    // Cancel all filtered vaults using batch manager
    try {
      await this._simulateTransaction(() =>
        vaultBatchManager.lpCancelVaults.staticCall(filteredVaultAddresses),
      );

      const result = await this._sendContractTxAndWait({
        contract: vaultBatchManager,
        functionName: "lpCancelVaults",
        functionArgs: [filteredVaultAddresses],
      });

      if (result.status == 1) {
        console.log(
          `Successfully cancelled vaults, tx hash: ${result.hash}, vault addresses: ${filteredVaultAddresses}`,
        );
      } else {
        console.error(
          `Failed to cancel vaults, vault addresses: ${filteredVaultAddresses}`,
        );
      }
    } catch (error) {
      console.error(
        `Failed to cancel vaults, vault addresses: ${filteredVaultAddresses}`,
      );
      console.error((error as EthersError).shortMessage);
    }
  }

  async showConfig() {
    console.log(JSON.stringify(this.config, null, 2));
  }

  async listAllVaults(lpAddress: string, rangeOptions?: VaultRangeOptions) {
    const factory = new ethers.Contract(
      this.config.factory,
      FactoryABI,
      this.signer,
    );

    const totalVaultsFromChain = await factory.getDeployedVaultCount();
    const totalVaults = Number(totalVaultsFromChain);

    if (totalVaults === 0) {
      console.log("No vaults have been deployed yet.");
      return;
    }

    const startFromOptions = rangeOptions?.start;
    const countFromOptions = rangeOptions?.count;

    if (
      startFromOptions !== undefined &&
      (!Number.isInteger(startFromOptions) || startFromOptions < 0)
    ) {
      throw new Error("start must be a non-negative integer");
    }

    if (
      countFromOptions !== undefined &&
      (!Number.isInteger(countFromOptions) || countFromOptions <= 0)
    ) {
      throw new Error("count must be a positive integer");
    }

    const resolveStartIndex = () => {
      if (startFromOptions !== undefined) {
        return startFromOptions;
      }
      if (countFromOptions !== undefined) {
        return Math.max(totalVaults - countFromOptions, 0);
      }
      return 0;
    };

    const startIndex = resolveStartIndex();

    if (startIndex >= totalVaults) {
      console.log(
        `Requested start index (${startIndex}) is beyond the total deployed vault count (${totalVaults}).`,
      );
      return;
    }

    const availableVaults = totalVaults - startIndex;
    let length =
      countFromOptions !== undefined
        ? countFromOptions
        : startFromOptions !== undefined
          ? Math.min(DEFAULT_VAULT_FETCH_COUNT, availableVaults)
          : availableVaults;

    length = Math.min(length, availableVaults);

    if (length === 0) {
      console.log("No vaults fall into the requested range.");
      return;
    }

    const endIndex = startIndex + length - 1;
    console.log(
      `Requesting vaults ${startIndex} to ${endIndex} (total deployed: ${totalVaults}).`,
    );

    const vaults = await factory.getDeployedVaults(
      BigInt(startIndex),
      BigInt(length),
    );

    this.provider.isMulticallEnabled = true;
    const vaultEntries = await Promise.all(
      vaults.map((vaultAddress: string, idx: number) => {
        return (async () => {
          const vault = new ethers.Contract(
            vaultAddress,
            VaultABI,
            this.signer,
          );
          const owner = await vault.owner();
          return {
            owner,
            vaultAddress,
            index: startIndex + idx,
          };
        })();
      }),
    );
    this.provider.isMulticallEnabled = false;

    const lpVaultEntries = vaultEntries.filter(
      (entry) => entry.owner === lpAddress,
    );

    if (lpVaultEntries.length === 0) {
      console.log(
        `No vaults owned by ${lpAddress} within the requested range (${startIndex}-${endIndex}).`,
      );
      return;
    }

    const lpVaultAddresses = lpVaultEntries.map((entry) => entry.vaultAddress);
    const formattedAddresses = [
      "[",
      ...lpVaultAddresses.map((address, idx) => {
        const suffix = idx === lpVaultAddresses.length - 1 ? "" : ",";
        return `  '${address}'${suffix}`;
      }),
      "]",
    ].join("\n");

    console.log(`Vaults owned by ${lpAddress}:`);
    console.log(formattedAddresses);
  }

  async showVault(vaultAddress: string) {
    const vault = new ethers.Contract(vaultAddress, VaultABI, this.signer);
    this.provider.isMulticallEnabled = true;
    const [
      linkedOraclePriceRaw,
      yieldValueRaw,
      isBuyLow,
      investmentTokenAddress,
      linkedTokenAddress,
      quantityRaw,
      state,
      expiry,
      depositTotalRaw,
    ] = await Promise.all([
      vault.linkedOraclePrice(),
      vault.yieldValue(),
      vault.isBuyLow(),
      vault.investmentToken(),
      vault.linkedToken(),
      vault.quantity(),
      vault.state(),
      vault.expiry(),
      vault.depositTotal(),
    ]);
    this.provider.isMulticallEnabled = false;

    const linkedOraclePrice = BigInt(linkedOraclePriceRaw);
    const yieldValue = BigInt(yieldValueRaw);
    const quantity = BigInt(quantityRaw);
    const depositTotal = BigInt(depositTotalRaw);

    const baseTokenAddress = isBuyLow
      ? linkedTokenAddress
      : investmentTokenAddress;

    const quoteTokenAddress = isBuyLow
      ? investmentTokenAddress
      : linkedTokenAddress;

    const tradingPairs = this.config.tradingPairs;
    const tradingPair = Object.keys(tradingPairs).find(
      (key) =>
        tradingPairs[key].baseToken === baseTokenAddress &&
        tradingPairs[key].quoteToken === quoteTokenAddress,
    );

    if (!tradingPair) {
      console.error("tradingPair not found in config");
      return;
    }

    const priceFeedDecimals = Number(
      tradingPairs[tradingPair].priceFeed.decimals,
    );

    const remainingQuantity = quantity - depositTotal;

    const investmentToken = await this._getToken(investmentTokenAddress);
    const investmentTokenDecimals = await investmentToken.decimals();
    const logs = await this.provider.getLogs({
      address: vaultAddress,
      fromBlock: 0,
      toBlock: "latest",
    });

    if (logs.length === 0) {
      throw new Error("Contract deployment transaction not found");
    }

    const creationLog = logs[0];
    const txHash = creationLog.transactionHash;
    const tx = await this.provider.getTransaction(txHash);
    const block = await this.provider.getBlock(tx.blockNumber);
    const timestamp = block.timestamp;
    const creationDate = new Date(Number(timestamp) * 1000);

    const result = {
      baseTokenAddress,
      quoteTokenAddress,
      linkedPrice: formatUnits(linkedOraclePrice, priceFeedDecimals),
      yieldValue: formatUnits(yieldValue, fixDecimals - 2),
      quantity: formatUnits(quantity, investmentTokenDecimals),
      remainingQuantity: formatUnits(
        remainingQuantity,
        investmentTokenDecimals,
      ),
      state,
      expiry: new Date(Number(expiry) * 1000),
      direction: isBuyLow ? "Buy Low" : "Sell High",
      creationDate,
    };

    console.log(`Base token address: ${result.baseTokenAddress}`);
    console.log(`Quote token address: ${result.quoteTokenAddress}`);
    console.log(`Linked Price: ${result.linkedPrice}`);
    console.log(`Yield: ${result.yieldValue}%`);
    console.log(`Creation Date: ${result.creationDate}`);
    console.log(`Expiry: ${result.expiry}`);
    console.log(`Direction: ${result.direction}`);
    console.log(`Quantity: ${result.quantity}`);
    console.log(`Remaining Quantity: ${result.remainingQuantity}`);
    console.log(`State: ${result.state}`);
  }
}
