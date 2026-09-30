import {
  expect,
  test,
  describe,
  jest,
  afterEach,
  beforeEach,
} from "@jest/globals";
import { ethers, EventLog, NonceManager } from "ethers";
import { VaultManager } from "../src/vault_manager";
import { BlockchainConfig } from "../src/types";
import { ERC7579_BATCH_MODE } from "../src/constants";
import * as utils from "../src/utils";

import FactoryABI from "../abi/Factory.json";
import RouterAbi from "../abi/Router.json";
import VaultABI from "../abi/Vault.json";
import VaultCoreABI from "../abi/VaultCore.json";
import IERC20ABI from "../abi/IERC20.json";
import CollateralPoolABI from "../abi/CollateralPool.json";
import IPythABI from "@pythnetwork/pyth-sdk-solidity/abis/IPyth.json";

const mockConfig = {
  rpcNode: "https://not.a.real.url",
  account: "0x1563915e194D8CfBA1943570603F7606A3115508",
  is7702Account: false,
  jsonWallet: "mock_encrypted_json_path",
  passphrase: "mock_passphrase",
  factory: "0x3333333333333333333333333333333333333333",
  router: "0x4444444444444444444444444444444444444444",
  vaultBatchManager: "0x5555555555555555555555555555555555555555",
  pythAggregator: "0x8888888888888888888888888888888888888888",
  pythPriceFeed: "0x9999999999999999999999999999999999999999",
  collateralPool: "0x1010101010101010101010101010101010101010",
  collateralPoolV2: "0x2020202020202020202020202020202020202020",
  tradingPairs: {
    "WETH-USDC": {
      baseToken: "0x5555555555555555555555555555555555555555",
      quoteToken: "0x6666666666666666666666666666666666666666",
      priceFeed: {
        type: "Not A Real Oracle",
        address: "0x777777777777777777777777777777777777777",
        id: "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        decimals: "8",
      },
    },
  },
};

const mockVaultAddress = "0x1234567890123456789012345678901234567890";

const mockBuyLowVaultOptions = {
  linkedPrice: "2500",
  quantity: "10",
  expiry: 1727769600,
  yieldPercentage: "3",
  tradingPair: "WETH-USDC",
  isBuyLow: true,
};

const mockSellHighVaultOptions = {
  linkedPrice: "4000",
  quantity: "5",
  expiry: 1727769600,
  yieldPercentage: "2",
  tradingPair: "WETH-USDC",
  isBuyLow: false,
};

const tradingPairConfig =
  mockConfig.tradingPairs[mockBuyLowVaultOptions.tradingPair];

const mockBasicSettings = {
  hermesApiBaseUrl: "https://hermes.pyth.network/",
};

const mockSigner = new NonceManager(
  new ethers.Wallet(
    "0x2222222222222222222222222222222222222222222222222222222222222222",
    new ethers.JsonRpcProvider(mockConfig.rpcNode),
  ),
);

jest
  .spyOn(VaultManager.prototype as any, "_initializeWallet")
  .mockReturnValue(mockSigner);

describe("VaultManager constructor", () => {
  test("create new instance", () => {
    const vaultManager = new VaultManager(mockConfig, mockBasicSettings);
    expect(vaultManager).toBeInstanceOf(VaultManager);
  });

  test("uses the configured Pyth Pro Hermes endpoint and API key", () => {
    const originalHermesUrl = process.env["PYTH_HERMES_URL"];
    const originalPythApiKey = process.env["PYTH_API_KEY"];
    process.env["PYTH_HERMES_URL"] = "https://pro.example/hermes/";
    process.env["PYTH_API_KEY"] = "test-api-key";

    try {
      const vaultManager = new VaultManager(mockConfig, mockBasicSettings);
      const pythConnection = vaultManager.pythConnection as any;
      expect(pythConnection.baseURL).toBe("https://pro.example/hermes/");
      expect(pythConnection.headers).toEqual({
        Authorization: "Bearer test-api-key",
      });
    } finally {
      if (originalHermesUrl) {
        process.env["PYTH_HERMES_URL"] = originalHermesUrl;
      } else {
        delete process.env["PYTH_HERMES_URL"];
      }
      if (originalPythApiKey) {
        process.env["PYTH_API_KEY"] = originalPythApiKey;
      } else {
        delete process.env["PYTH_API_KEY"];
      }
    }
  });

  test("uses the Pyth API key from basic settings", () => {
    const originalPythApiKey = process.env["PYTH_API_KEY"];
    delete process.env["PYTH_API_KEY"];

    try {
      const vaultManager = new VaultManager(mockConfig, {
        ...mockBasicSettings,
        pythApiKey: "config-api-key",
      });
      const pythConnection = vaultManager.pythConnection as any;
      expect(pythConnection.headers).toEqual({
        Authorization: "Bearer config-api-key",
      });
    } finally {
      if (originalPythApiKey) {
        process.env["PYTH_API_KEY"] = originalPythApiKey;
      } else {
        delete process.env["PYTH_API_KEY"];
      }
    }
  });

  test("throws error when required config fields are missing", () => {
    const incompleteConfigs: Partial<BlockchainConfig>[] = [
      { ...mockConfig, rpcNode: undefined },
      { ...mockConfig, jsonWallet: undefined },
      { ...mockConfig, passphrase: undefined },
      { ...mockConfig, factory: undefined },
      { ...mockConfig, router: undefined },
    ];

    incompleteConfigs.forEach((config) => {
      expect(
        () => new VaultManager(config as BlockchainConfig, mockBasicSettings),
      ).toThrow();
    });
  });

  test("throws specific error messages for missing config fields", () => {
    const configTests = [
      { field: "rpcNode", expectedError: "rpcNode is not set" },
      { field: "jsonWallet", expectedError: "wallet path is not set" },
      { field: "passphrase", expectedError: "passphrase is not set" },
      { field: "factory", expectedError: "factory is not set" },
      { field: "router", expectedError: "router is not set" },
    ];

    configTests.forEach(({ field, expectedError }) => {
      const incompleteConfig = { ...mockConfig, [field]: undefined };
      expect(
        () =>
          new VaultManager(
            incompleteConfig as BlockchainConfig,
            mockBasicSettings,
          ),
      ).toThrow(expectedError);
    });
  });
});

const mockConsoleLog = jest.spyOn(console, "log").mockImplementation(() => {});
const mockConsoleError = jest
  .spyOn(console, "error")
  .mockImplementation(() => {});

const mockBase64Data =
  "eyJwcmljZSI6IDEyMy40NSwic3ltYm9sIjogIkJUQ1VTRCIsICJ0aW1lc3RhbXAiOiAxNjM0MDc1NjAwfQ==";
const mockBinaryData = Buffer.from(mockBase64Data, "base64");
const mockHexData = mockBinaryData.toString("hex");
const mockedParsedData = [
  {
    id: "9db37f4d5654aad3e37e2e14ffd8d53265fb3026d1d8f91146539eebaa2ef45f",
    price: {
      price: "134865270",
      conf: "296784",
      expo: -8,
      publish_time: 1731865158,
    },
    ema_price: {
      price: "134435181",
      conf: "314728",
      expo: -8,
      publish_time: 1731865158,
    },
    metadata: {
      slot: 178617999,
      proof_available_time: 1731865159,
      prev_publish_time: 1731865158,
    },
  },
];

describe("VaultManager createVault", () => {
  const vaultManager = new VaultManager(mockConfig, mockBasicSettings);
  const spyPythConnection = jest
    .spyOn(vaultManager.pythConnection, "getLatestPriceUpdates")
    .mockResolvedValue({
      binary: {
        encoding: "hex",
        data: [mockHexData],
      },
      parsed: mockedParsedData,
    });

  afterEach(() => {
    jest.clearAllMocks();
  });

  const vaultCreationLog = Object.create(EventLog.prototype);
  Object.assign(vaultCreationLog, {
    address: "0xDe7c16c01CF3bABdA73a7516b2a5195A3B1F767e",
    blockHash:
      "0xc81b4c5ae1b5cd2e56be4c164df8c1aa9362e58a99fe0c4ef2fcfc3a533dc9c5",
    blockNumber: 7601043,
    data: "0x0000000000000000000000001bb4e6ae7719bb9aa3ddc7c4ea95fdbd4005bab40000000000000000000000000000000000000000000000000000000067515d8000000000000000000000000000000000000000000000000000000000b2d05e0000000000000000000000000000000000000000000000000000000045d964b800000000000000000000000000000000000000000000000000002386f26fc1000000000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000005f5e100000000000000000000000000000000000000000000000000000000006750b4c000000000000000000000000000000000000000000000000000f5232269808000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000db31302c",
    index: 320,
    topics: [
      "0x5abfe8ee47acb8d4a732ceac1ba1afc1eabbb14b7a8848e885f5ecddb5f5af33",
      "0x000000000000000000000000f4d594914ad2085795a746ec3713d652edbb6e10",
      "0x00000000000000000000000029ca87b2f744127606ada4564da8219be6498ca1",
      "0x000000000000000000000000137df25cabf220a180300604e57551ac1397959d",
    ],
    transactionHash:
      "0x0c80e91ae276b481c9204052d49570457f8e2aebe960277e40dff1dc08a79580",
    transactionIndex: 29,
  });
  const mockCreateVaultWait = jest
    .fn<() => Promise<object>>()
    .mockResolvedValue({
      status: 1,
      on: () => {},
      logs: [vaultCreationLog],
    });

  const mockApproveWait = jest
    .fn<() => Promise<object>>()
    .mockResolvedValue({ status: 1 });

  const mockApproveVaultWait = jest
    .fn<() => Promise<object>>()
    .mockResolvedValue({ status: 1 });

  const mockContract = {
    interface: {
      parseLog: jest.fn().mockReturnValue({
        name: "VaultCreated",
        args: { vaultAddress: "0x1bb4E6ae7719bB9Aa3dDC7c4eA95FDBD4005BAb4" },
      }),
    },
    events: {
      VaultCreated: jest.fn().mockReturnValue({
        abi: {
          inputs: FactoryABI.filter(
            (item) => item["type"] == "event" && item["name"] == "VaultCreated",
          )[0].inputs,
        },
      }),
    },
    decimals: jest.fn().mockReturnValue(18),
    approve: (() => {
      const fn = jest.fn().mockReturnValue({
        wait: mockApproveWait,
      });
      (fn as any).staticCall = jest
        .fn()
        .mockImplementation(() => Promise.resolve());
      return fn;
    })(),
    balanceOf: jest.fn().mockReturnValue(900000000000000000000000000n),
    allowance: jest
      .fn()
      .mockReturnValueOnce(0n)
      .mockReturnValueOnce(1000000000000000000000000n)
      .mockReturnValueOnce(0n)
      .mockReturnValue(1000000000000000000000000n),
    name: jest.fn().mockReturnValue("ETH"),
    createVault: (() => {
      const fn = jest.fn().mockReturnValue({
        wait: mockCreateVaultWait,
      });
      (fn as any).staticCall = jest
        .fn()
        .mockImplementation(() => Promise.resolve());
      return fn;
    })(),
    getUpdateFee: jest.fn().mockReturnValue(1n),
    getPresetFeeParams: jest.fn().mockReturnValue({
      tradingFeeRate: 69000000000000000n,
    }),
    getTradingFeeTiers: jest.fn().mockReturnValue([
      { minimumVolume: 0n, feeRate: 69000000000000000n },
      { minimumVolume: 4200000000n, feeRate: 42000000000000000n },
      { minimumVolume: 42000000000n, feeRate: 24000000000000000n },
    ]),
    approveVault: (() => {
      const fn = jest.fn().mockReturnValue({
        wait: mockApproveVaultWait,
      });
      (fn as any).staticCall = jest
        .fn()
        .mockImplementation(() => Promise.resolve());
      return fn;
    })(),
  };
  test("create new buy low vault successfully", async () => {
    const spyContract = jest
      .spyOn(ethers, "Contract")
      .mockReturnValue(mockContract as unknown as ethers.Contract);

    await vaultManager.createVault(mockBuyLowVaultOptions);

    expect(spyContract).toHaveBeenCalledTimes(4);
    expect(spyContract).toHaveBeenNthCalledWith(
      1,
      mockConfig.factory,
      FactoryABI,
      mockSigner,
    );
    expect(spyContract).toHaveBeenNthCalledWith(
      2,
      tradingPairConfig.baseToken,
      IERC20ABI,
      mockSigner,
    );
    expect(spyContract).toHaveBeenNthCalledWith(
      3,
      tradingPairConfig.quoteToken,
      IERC20ABI,
      mockSigner,
    );
    expect(spyContract).toHaveBeenNthCalledWith(
      4,
      mockConfig.pythPriceFeed,
      IPythABI,
      mockSigner,
    );

    expect(mockContract.createVault).toHaveBeenCalledWith(
      {
        baseToken: tradingPairConfig.baseToken,
        expiry: mockBuyLowVaultOptions.expiry,
        isBuyLow: mockBuyLowVaultOptions.isBuyLow,
        linkedOraclePrice: "250000000000",
        owner: mockConfig.account,
        quantity: "10000000000000000000",
        quoteToken: tradingPairConfig.quoteToken,
        yieldValue: "30000000000000000",
        useCollateralPool: false,
        useNativeToken: false,
        vaultSeriesVersion: 1,
        signer: mockConfig.account,
      },
      [mockBinaryData],
      { value: 1n, gasLimit: 3000000 },
    );

    expect(mockCreateVaultWait).toHaveBeenCalled();
  });

  test("create new sell high vault successfully", async () => {
    const spyContract = jest
      .spyOn(ethers, "Contract")
      .mockReturnValue(mockContract as unknown as ethers.Contract);

    await vaultManager.createVault(mockSellHighVaultOptions);

    expect(spyContract).toHaveBeenCalledTimes(4);
    expect(spyContract).toHaveBeenNthCalledWith(
      1,
      mockConfig.factory,
      FactoryABI,
      mockSigner,
    );
    expect(spyContract).toHaveBeenNthCalledWith(
      2,
      tradingPairConfig.baseToken,
      IERC20ABI,
      mockSigner,
    );
    expect(spyContract).toHaveBeenNthCalledWith(
      3,
      tradingPairConfig.quoteToken,
      IERC20ABI,
      mockSigner,
    );
    expect(spyContract).toHaveBeenNthCalledWith(
      4,
      mockConfig.pythPriceFeed,
      IPythABI,
      mockSigner,
    );

    expect(mockContract.createVault).toHaveBeenCalledWith(
      {
        baseToken: tradingPairConfig.baseToken,
        expiry: mockSellHighVaultOptions.expiry,
        isBuyLow: mockSellHighVaultOptions.isBuyLow,
        linkedOraclePrice: "400000000000",
        owner: mockConfig.account,
        quantity: "5000000000000000000",
        quoteToken: tradingPairConfig.quoteToken,
        yieldValue: "20000000000000000",
        useCollateralPool: false,
        useNativeToken: false,
        vaultSeriesVersion: 1,
        signer: mockConfig.account,
      },
      [mockBinaryData],
      { value: 1n, gasLimit: 3000000 },
    );

    expect(mockCreateVaultWait).toHaveBeenCalled();
  });

  test("create new collateralPool vault successfully", async () => {
    const spyContract = jest
      .spyOn(ethers, "Contract")
      .mockReturnValue(mockContract as unknown as ethers.Contract);

    await vaultManager.createVault({
      ...mockBuyLowVaultOptions,
      useCollateralPool: true,
    });

    expect(spyContract).toHaveBeenCalledTimes(5);
    expect(spyContract).toHaveBeenCalledWith(
      mockConfig.factory,
      FactoryABI,
      mockSigner,
    );
    expect(spyContract).toHaveBeenCalledWith(
      mockConfig.pythPriceFeed,
      IPythABI,
      mockSigner,
    );
    expect(spyContract).toHaveBeenCalledWith(
      mockConfig.collateralPool,
      CollateralPoolABI,
      mockSigner,
    );

    expect(mockContract.createVault).toHaveBeenCalledWith(
      {
        baseToken: tradingPairConfig.baseToken,
        expiry: mockBuyLowVaultOptions.expiry,
        isBuyLow: mockBuyLowVaultOptions.isBuyLow,
        linkedOraclePrice: "250000000000",
        owner: mockConfig.account,
        quantity: "10000000000000000000",
        quoteToken: tradingPairConfig.quoteToken,
        yieldValue: "30000000000000000",
        useCollateralPool: true,
        useNativeToken: false,
        vaultSeriesVersion: 1,
        signer: mockConfig.account,
      },
      [mockBinaryData],
      { value: 1n, gasLimit: 3000000 },
    );

    expect(mockCreateVaultWait).toHaveBeenCalled();
    expect(mockApproveVaultWait).toHaveBeenCalled();
  });

  test("should throw errors for invalid trading pair configurations", async () => {
    const invalidCreateVaultOptions = {
      linkedPrice: "2500",
      quantity: "1",
      expiry: 1727769600,
      yieldPercentage: "1",
    };

    // Test missing tradingPair
    await expect(
      vaultManager.createVault(invalidCreateVaultOptions as any),
    ).rejects.toThrow("tradingPair is not set");

    // Test invalid tradingPair
    await expect(
      vaultManager.createVault({
        ...invalidCreateVaultOptions,
        tradingPair: "INVALID-PAIR",
      }),
    ).rejects.toThrow("tradingPair is not valid");

    // Prepare a mock config with missing properties
    const mockInvalidConfig = JSON.parse(JSON.stringify(mockConfig));
    mockInvalidConfig.tradingPairs["MOCK-PAIR"] = {};

    const mockVaultManager = new VaultManager(
      mockInvalidConfig,
      mockBasicSettings,
    );

    // Test missing baseToken
    await expect(
      mockVaultManager.createVault({
        ...invalidCreateVaultOptions,
        tradingPair: "MOCK-PAIR",
      }),
    ).rejects.toThrow("baseToken is not set");

    // Test missing quoteToken
    mockInvalidConfig.tradingPairs["MOCK-PAIR"].baseToken =
      "0x1234567890123456789012345678901234567890";
    await expect(
      mockVaultManager.createVault({
        ...invalidCreateVaultOptions,
        tradingPair: "MOCK-PAIR",
      }),
    ).rejects.toThrow("quoteToken is not set");

    // Test missing decimals
    mockInvalidConfig.tradingPairs["MOCK-PAIR"].quoteToken =
      "0x0987654321098765432109876543210987654321";
    mockInvalidConfig.tradingPairs["MOCK-PAIR"].priceFeed = {};
    await expect(
      mockVaultManager.createVault({
        ...invalidCreateVaultOptions,
        tradingPair: "MOCK-PAIR",
      }),
    ).rejects.toThrow("decimals is not set");
  });

  test("should throw error for invalid is7702Account value", async () => {
    await expect(
      vaultManager.createVault({
        ...mockBuyLowVaultOptions,
        is7702Account: "flse",
      }),
    ).rejects.toThrow("is7702Account value not valid");
  });

  test("should throw error when using custom signer with vault series version 1", async () => {
    const createVaultOptionsWithSigner = {
      ...mockBuyLowVaultOptions,
      signer: "0x1234567890123456789012345678901234567890",
    };

    await expect(
      vaultManager.createVault(createVaultOptionsWithSigner),
    ).rejects.toThrow(
      "Custom signer is not supported for vault series version 1",
    );

    // Also test with explicit vaultSeriesVersion = 1
    await expect(
      vaultManager.createVault({
        ...createVaultOptionsWithSigner,
        vaultSeriesVersion: 1,
      }),
    ).rejects.toThrow(
      "Custom signer is not supported for vault series version 1",
    );
  });

  test("ignores overflow panic in simulation", async () => {
    jest
      .spyOn(ethers, "Contract")
      .mockReturnValue(mockContract as unknown as ethers.Contract);
    (mockContract.createVault as any).staticCall.mockRejectedValueOnce({
      reason: "Panic due to OVERFLOW(17)",
    });

    await vaultManager.createVault(mockBuyLowVaultOptions);

    expect((mockContract.createVault as any).staticCall).toHaveBeenCalledTimes(
      1,
    );
    expect(mockContract.createVault).toHaveBeenCalledTimes(1);
  });

  test("still throws for other simulation errors", async () => {
    jest
      .spyOn(ethers, "Contract")
      .mockReturnValue(mockContract as unknown as ethers.Contract);
    (mockContract.createVault as any).staticCall.mockRejectedValueOnce({
      reason: "revert error",
    });

    await expect(
      vaultManager.createVault(mockBuyLowVaultOptions),
    ).rejects.toEqual({ reason: "revert error" });
    expect(mockContract.createVault).not.toHaveBeenCalled();
  });
});

describe("VaultManager createVault with ERC-7579 batch", () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  const is7702Config = { ...mockConfig, is7702Account: true };
  const bigAllowance = 1000000000000000000000000n;

  const buildBatchMocks = (options?: {
    allowance?: ReturnType<typeof jest.fn>;
    staticCallError?: Error;
    receiptLogs?: object[];
  }) => {
    const executeWait = jest.fn<() => Promise<object>>().mockResolvedValue({
      status: 1,
      logs: options?.receiptLogs ?? [{ topics: [], data: "0x" }],
    });
    const executeStaticCall = options?.staticCallError
      ? jest
          .fn()
          .mockImplementation(() => Promise.reject(options.staticCallError))
      : jest.fn().mockImplementation(() => Promise.resolve());
    const execute = (() => {
      const fn = jest.fn().mockReturnValue({ wait: executeWait });
      (fn as unknown as { staticCall: unknown }).staticCall = executeStaticCall;
      return fn;
    })();
    const approveWait = jest
      .fn<() => Promise<object>>()
      .mockResolvedValue({ status: 1 });
    const createVaultWait = jest.fn<() => Promise<object>>().mockResolvedValue({
      status: 1,
      logs: [{ topics: [], data: "0x" }],
    });
    const contract = {
      interface: {
        parseLog: jest.fn().mockReturnValue({
          name: "VaultCreated",
          args: { vaultAddress: "0x1bb4E6ae7719bB9Aa3dDC7c4eA95FDBD4005BAb4" },
        }),
      },
      decimals: jest.fn().mockReturnValue(18),
      balanceOf: jest.fn().mockReturnValue(900000000000000000000000000n),
      allowance: options?.allowance ?? jest.fn().mockReturnValue(0n),
      name: jest.fn().mockReturnValue("ETH"),
      getUpdateFee: jest.fn().mockReturnValue(1n),
      getPresetFeeParams: jest.fn().mockReturnValue({
        tradingFeeRate: 69000000000000000n,
      }),
      getTradingFeeTiers: jest
        .fn()
        .mockReturnValue([{ minimumVolume: 0n, feeRate: 69000000000000000n }]),
      approve: (() => {
        const fn = jest.fn().mockReturnValue({ wait: approveWait });
        (fn as unknown as { staticCall: unknown }).staticCall = jest
          .fn()
          .mockImplementation(() => Promise.resolve());
        return fn;
      })(),
      createVault: (() => {
        const fn = jest.fn().mockReturnValue({ wait: createVaultWait });
        (fn as unknown as { staticCall: unknown }).staticCall = jest
          .fn()
          .mockImplementation(() => Promise.resolve());
        return fn;
      })(),
      execute,
    };
    return {
      contract,
      execute,
      executeStaticCall,
      approveWait,
      createVaultWait,
    };
  };

  const delegatedCode = "0xef010063c0c19a282a1b52b07dd5a65b58948a07dae32b";

  const newVaultManager = (onChainCode: string = delegatedCode) => {
    const vaultManager = new VaultManager(is7702Config, mockBasicSettings);
    jest.spyOn(vaultManager.provider, "getCode").mockResolvedValue(onChainCode);
    jest
      .spyOn(vaultManager.pythConnection, "getLatestPriceUpdates")
      .mockResolvedValue({
        binary: { encoding: "hex", data: [mockHexData] },
        parsed: mockedParsedData,
      });
    return vaultManager;
  };

  const decodeBatchCalls = (executionCalldata: string) => {
    const [calls] = ethers.AbiCoder.defaultAbiCoder().decode(
      ["tuple(address target, uint256 value, bytes callData)[]"],
      executionCalldata,
    );
    return calls;
  };

  test("batches approve + approve + createVault into a single transaction", async () => {
    const { contract, execute, approveWait } = buildBatchMocks();
    jest
      .spyOn(ethers, "Contract")
      .mockReturnValue(contract as unknown as ethers.Contract);

    const vaultManager = newVaultManager();
    await vaultManager.createVault(mockBuyLowVaultOptions);

    expect(execute).toHaveBeenCalledTimes(1);
    expect(contract.approve).not.toHaveBeenCalled();
    expect(approveWait).not.toHaveBeenCalled();
    expect(contract.createVault).not.toHaveBeenCalled();

    const [mode, executionCalldata] = execute.mock.calls[0] as [
      string,
      string,
      object,
    ];
    expect(mode).toBe(ERC7579_BATCH_MODE);
    const calls = decodeBatchCalls(executionCalldata);
    expect(calls.length).toBe(3);
    expect(calls[0].target).toBe(tradingPairConfig.baseToken);
    expect(calls[1].target).toBe(tradingPairConfig.quoteToken);
    expect(calls[2].target).toBe(mockConfig.factory);
    expect(calls[2].value).toBe(1n);
  });

  test("skips approve calls whose allowance is already sufficient", async () => {
    const allowance = jest
      .fn()
      .mockReturnValueOnce(bigAllowance) // linked token is covered
      .mockReturnValue(0n); // investment token needs approve
    const { contract, execute } = buildBatchMocks({ allowance });
    jest
      .spyOn(ethers, "Contract")
      .mockReturnValue(contract as unknown as ethers.Contract);

    const vaultManager = newVaultManager();
    await vaultManager.createVault(mockBuyLowVaultOptions);

    const calls = decodeBatchCalls(execute.mock.calls[0][1] as string);
    expect(calls.length).toBe(2);
    // Buy low: linked = baseToken (skipped), investment = quoteToken
    expect(calls[0].target).toBe(tradingPairConfig.quoteToken);
    expect(calls[1].target).toBe(mockConfig.factory);
  });

  test("falls back to the sequential path on an empty revert", async () => {
    const staticCallError = Object.assign(new Error("execution reverted"), {
      code: "CALL_EXCEPTION",
      data: "0x",
    });
    // allowance order: batch builder twice, then per-approve check + visibility
    const allowance = jest
      .fn()
      .mockReturnValueOnce(0n)
      .mockReturnValueOnce(0n)
      .mockReturnValueOnce(0n)
      .mockReturnValueOnce(bigAllowance)
      .mockReturnValueOnce(0n)
      .mockReturnValue(bigAllowance);
    const { contract, execute, approveWait, createVaultWait } = buildBatchMocks(
      { allowance, staticCallError },
    );
    jest
      .spyOn(ethers, "Contract")
      .mockReturnValue(contract as unknown as ethers.Contract);

    const vaultManager = newVaultManager();
    await vaultManager.createVault(mockBuyLowVaultOptions);

    // batch tx is never sent
    expect(execute).not.toHaveBeenCalled();
    expect(approveWait).toHaveBeenCalledTimes(2);
    expect(contract.createVault).toHaveBeenCalledTimes(1);
    expect(createVaultWait).toHaveBeenCalledTimes(1);
  });

  test("throws business errors from batch simulation without falling back", async () => {
    const staticCallError = Object.assign(new Error("execution reverted"), {
      code: "CALL_EXCEPTION",
      data: "0x2acbe915", // custom error
    });
    const { contract, execute, approveWait } = buildBatchMocks({
      staticCallError,
    });
    jest
      .spyOn(ethers, "Contract")
      .mockReturnValue(contract as unknown as ethers.Contract);

    const vaultManager = newVaultManager();
    await expect(
      vaultManager.createVault(mockBuyLowVaultOptions),
    ).rejects.toThrow("execution reverted");

    expect(execute).not.toHaveBeenCalled();
    expect(approveWait).not.toHaveBeenCalled();
    expect(contract.createVault).not.toHaveBeenCalled();
  });

  test("throws when the batch tx mined without a VaultCreated event", async () => {
    const { contract, execute, approveWait } = buildBatchMocks({
      receiptLogs: [],
    });
    jest
      .spyOn(ethers, "Contract")
      .mockReturnValue(contract as unknown as ethers.Contract);

    const vaultManager = newVaultManager();
    await expect(
      vaultManager.createVault(mockBuyLowVaultOptions),
    ).rejects.toThrow("Vault creation event not found");

    // Never retry with the sequential path after a mined batch tx
    expect(execute).toHaveBeenCalledTimes(1);
    expect(approveWait).not.toHaveBeenCalled();
    expect(contract.createVault).not.toHaveBeenCalled();
  });

  test("treats the account as a regular EOA when the 7702 claim is not on-chain", async () => {
    const allowance = jest
      .fn()
      .mockReturnValueOnce(0n) // linked token needs approve
      .mockReturnValueOnce(0n) // investment token needs approve
      .mockReturnValue(bigAllowance); // visibility polls succeed
    const {
      contract,
      execute,
      executeStaticCall,
      approveWait,
      createVaultWait,
    } = buildBatchMocks({ allowance });
    jest
      .spyOn(ethers, "Contract")
      .mockReturnValue(contract as unknown as ethers.Contract);

    const vaultManager = newVaultManager("0x"); // no delegation on-chain
    await vaultManager.createVault(mockBuyLowVaultOptions);

    expect(executeStaticCall).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect(approveWait).toHaveBeenCalledTimes(2);
    expect(contract.createVault).toHaveBeenCalledTimes(1);
    expect(createVaultWait).toHaveBeenCalledTimes(1);
  });

  test("retries sequentially when concurrent approvals hit the in-flight limit", async () => {
    const inflightError = new Error(
      'could not coalesce error (error={ "code": -32000, "message": "in-flight transaction limit reached for delegated accounts" })',
    );
    const allowance = jest
      .fn()
      .mockReturnValueOnce(0n) // linked builder needs approve
      .mockReturnValueOnce(0n) // investment builder needs approve
      .mockReturnValueOnce(bigAllowance) // linked visibility poll
      .mockReturnValueOnce(bigAllowance) // retry linked builder skips
      .mockReturnValueOnce(0n) // retry investment builder approves
      .mockReturnValue(bigAllowance); // retry investment visibility poll
    const { contract, execute, approveWait, createVaultWait } = buildBatchMocks(
      { allowance },
    );
    let approveSendCount = 0;
    const approveFn = jest.fn().mockImplementation(() => {
      approveSendCount += 1;
      if (approveSendCount === 2) {
        throw inflightError;
      }
      return { wait: approveWait };
    });
    (approveFn as unknown as { staticCall: unknown }).staticCall = jest
      .fn()
      .mockImplementation(() => Promise.resolve());
    (contract as { approve: unknown }).approve = approveFn;
    jest
      .spyOn(ethers, "Contract")
      .mockReturnValue(contract as unknown as ethers.Contract);

    // mockConfig has is7702Account: false, so the concurrent path is taken
    const vaultManager = new VaultManager(mockConfig, mockBasicSettings);
    jest
      .spyOn(vaultManager.pythConnection, "getLatestPriceUpdates")
      .mockResolvedValue({
        binary: { encoding: "hex", data: [mockHexData] },
        parsed: mockedParsedData,
      });
    const nonceResetSpy = jest.spyOn(mockSigner, "reset");

    await vaultManager.createVault(mockBuyLowVaultOptions);

    expect(execute).not.toHaveBeenCalled();
    // concurrent: 1 ok + 1 rejected; retry: 1
    expect(approveFn).toHaveBeenCalledTimes(3);
    expect(approveWait).toHaveBeenCalledTimes(2);
    expect(contract.createVault).toHaveBeenCalledTimes(1);
    expect(createVaultWait).toHaveBeenCalledTimes(1);
    expect(nonceResetSpy).toHaveBeenCalled();
  });

  test("relayer mode does not attempt batch execution", async () => {
    const originalEnv = process.env;
    process.env = {
      ...originalEnv,
      OZ_RELAYER_URL: "https://relayer.example/",
      OZ_RELAYER_API_KEY: "test-api-key",
      OZ_RELAYER_ID: "relayer-1",
    };
    try {
      const vaultManager = new VaultManager(is7702Config, mockBasicSettings);
      const result = await (
        vaultManager as unknown as {
          _tryExecuteBatch: (
            calls: object[],
            value: bigint,
          ) => Promise<{ status: string }>;
        }
      )._tryExecuteBatch([], 0n);
      expect(result).toEqual({ status: "unsupported" });
    } finally {
      process.env = originalEnv;
    }
  });
});

describe("VaultManager _is7702Account", () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  const mockDelegatedCode = "0xef010063c0c19a282a1b52b07dd5a65b58948a07dae32b";

  test("CLI override takes precedence over config", async () => {
    const vaultManager = new VaultManager(mockConfig, mockBasicSettings);
    const spyGetCode = jest.spyOn(vaultManager.provider, "getCode");

    await expect(vaultManager._is7702Account(true)).resolves.toBe(true);
    await expect(vaultManager._is7702Account(false)).resolves.toBe(false);
    expect(spyGetCode).not.toHaveBeenCalled();
  });

  test("config field is used without on-chain detection", async () => {
    const vaultManager = new VaultManager(
      { ...mockConfig, is7702Account: true },
      mockBasicSettings,
    );
    const spyGetCode = jest.spyOn(vaultManager.provider, "getCode");

    await expect(vaultManager._is7702Account()).resolves.toBe(true);
    expect(spyGetCode).not.toHaveBeenCalled();
  });

  test("detects EIP-7702 delegation on-chain and caches the result", async () => {
    const configWithoutFlag = { ...mockConfig, is7702Account: undefined };
    const vaultManager = new VaultManager(configWithoutFlag, mockBasicSettings);
    const spyGetCode = jest
      .spyOn(vaultManager.provider, "getCode")
      .mockResolvedValue(mockDelegatedCode.toUpperCase().replace("0X", "0x"));

    await expect(vaultManager._is7702Account()).resolves.toBe(true);
    await expect(vaultManager._is7702Account()).resolves.toBe(true);
    // The detection result is cached per instance
    expect(spyGetCode).toHaveBeenCalledTimes(1);
  });

  test("plain EOA without code is not treated as 7702", async () => {
    const configWithoutFlag = { ...mockConfig, is7702Account: undefined };
    const vaultManager = new VaultManager(configWithoutFlag, mockBasicSettings);
    jest.spyOn(vaultManager.provider, "getCode").mockResolvedValue("0x");

    await expect(vaultManager._is7702Account()).resolves.toBe(false);
  });
});

describe("VaultManager cancelVault", () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  const vaultManager = new VaultManager(mockConfig, mockBasicSettings);

  test("cancel vault successfully", async () => {
    const mockCancelWait = jest
      .fn<() => Promise<object>>()
      .mockResolvedValue({ status: 1 });

    const mockApproveWait = jest
      .fn<() => Promise<object>>()
      .mockResolvedValue({ status: 1 });

    const mockContract = {
      isBuyLow: jest.fn().mockReturnValue(mockBuyLowVaultOptions.isBuyLow),
      investmentToken: jest.fn().mockReturnValue(tradingPairConfig.baseToken),
      decimals: jest.fn().mockReturnValue(6),
      linkedToken: jest.fn().mockReturnValue(tradingPairConfig.quoteToken),
      quantity: jest.fn().mockReturnValue(mockBuyLowVaultOptions.quantity),
      depositTotal: jest.fn().mockReturnValue("100000000"),
      oraclePriceAtCreation: jest
        .fn()
        .mockReturnValue(tradingPairConfig.priceFeed.address),
      lpCancel: (() => {
        const fn = jest.fn().mockReturnValue({
          wait: mockCancelWait,
        });
        (fn as any).staticCall = jest
          .fn()
          .mockImplementation(() => Promise.resolve());
        return fn;
      })(),
      approve: (() => {
        const fn = jest.fn().mockReturnValue({
          wait: mockApproveWait,
        });
        (fn as any).staticCall = jest
          .fn()
          .mockImplementation(() => Promise.resolve());
        return fn;
      })(),
      balanceOf: jest.fn().mockReturnValue(9000000000000000n),
      allowance: jest
        .fn()
        .mockReturnValueOnce(0n)
        .mockReturnValue(1000000000000000000000000n),
      name: jest.fn().mockReturnValue("ETH"),
    };

    const spyContract = jest
      .spyOn(ethers, "Contract")
      .mockReturnValue(mockContract as unknown as ethers.Contract);

    await vaultManager.cancelVault(mockVaultAddress);

    expect(spyContract).toHaveBeenNthCalledWith(
      1,
      mockVaultAddress,
      VaultABI,
      mockSigner,
    );

    expect(mockCancelWait).toHaveBeenCalledTimes(1);
  });
});

describe("VaultManager ERC-7579 batch for subscribeVault and adjustVaultYield", () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  const is7702Config = { ...mockConfig, is7702Account: true };
  const delegatedCode = "0xef010063c0c19a282a1b52b07dd5a65b58948a07dae32b";
  const routerInterface = new ethers.Interface(RouterAbi);
  const vaultInterface = new ethers.Interface(VaultABI);
  const erc20Interface = new ethers.Interface(IERC20ABI);

  const buildTxFn = () => {
    const wait = jest
      .fn<() => Promise<object>>()
      .mockResolvedValue({ status: 1 });
    const fn = jest.fn().mockReturnValue({ wait });
    (fn as any).staticCall = jest
      .fn()
      .mockImplementation(() => Promise.resolve());
    return fn;
  };

  const decodeBatchCalls = (executionCalldata: string) => {
    const [calls] = ethers.AbiCoder.defaultAbiCoder().decode(
      ["tuple(address target, uint256 value, bytes callData)[]"],
      executionCalldata,
    );
    return calls;
  };

  const newVaultManager = () => {
    const vaultManager = new VaultManager(is7702Config, mockBasicSettings);
    jest
      .spyOn(vaultManager.provider, "getCode")
      .mockResolvedValue(delegatedCode);
    jest
      .spyOn(vaultManager.pythConnection, "getLatestPriceUpdates")
      .mockResolvedValue({
        binary: { encoding: "hex", data: [mockHexData] },
        parsed: mockedParsedData,
      });
    return vaultManager;
  };

  test("subscribeVault batches approve + deposit into a single transaction", async () => {
    const mockContract = {
      investmentToken: jest.fn().mockReturnValue(tradingPairConfig.quoteToken),
      linkedToken: jest.fn().mockReturnValue(tradingPairConfig.baseToken),
      decimals: jest.fn().mockReturnValue(6),
      balanceOf: jest.fn().mockReturnValue(9000000000000000n),
      allowance: jest.fn().mockReturnValue(0n),
      name: jest.fn().mockReturnValue("USDC"),
      isBuyLow: jest.fn().mockReturnValue(true),
      symbol: jest.fn().mockReturnValueOnce("WETH").mockReturnValueOnce("USDC"),
      getUpdateFee: jest.fn().mockReturnValue(1n),
      approve: buildTxFn(),
      deposit: buildTxFn(),
      execute: buildTxFn(),
    };
    jest
      .spyOn(ethers, "Contract")
      .mockReturnValue(mockContract as unknown as ethers.Contract);

    const vaultManager = newVaultManager();
    await vaultManager.subscribeVault(mockVaultAddress, "1");

    expect(mockContract.execute).toHaveBeenCalledTimes(1);
    expect(mockContract.approve).not.toHaveBeenCalled();
    expect(mockContract.deposit).not.toHaveBeenCalled();
    expect(mockConsoleLog).toHaveBeenCalledWith(
      `Vault ${mockVaultAddress} subscribed successfully`,
    );

    const [mode, executionCalldata, overrides] = mockContract.execute.mock
      .calls[0] as [string, string, { value: bigint }];
    expect(mode).toBe(ERC7579_BATCH_MODE);
    expect(overrides.value).toBe(1n);
    const calls = decodeBatchCalls(executionCalldata);
    expect(calls.length).toBe(2);

    expect(calls[0].target).toBe(tradingPairConfig.quoteToken);
    const approve = erc20Interface.parseTransaction({
      data: calls[0].callData,
    });
    expect(approve?.args[0]).toBe(mockConfig.router);
    expect(approve?.args[1]).toBe(1000000n);

    expect(calls[1].target).toBe(mockConfig.router);
    expect(calls[1].value).toBe(1n);
    const deposit = routerInterface.parseTransaction({
      data: calls[1].callData,
    });
    expect(deposit?.signature).toBe("deposit(address,uint256,uint256,bytes[])");
    expect(deposit?.args[0]).toBe(mockVaultAddress);
    expect(deposit?.args[1]).toBe(1000000n);
  });

  test("adjustVaultYield batches approve + approve + adjustYieldValue into a single transaction", async () => {
    jest
      .spyOn(utils, "calculateTokenAmounts")
      .mockReturnValueOnce({
        linkedTokenAmount: 318000000000000000n,
        investmentTokenAmount: 45900000n,
      })
      .mockReturnValueOnce({
        linkedTokenAmount: 6384000000000000000n,
        investmentTokenAmount: 1744200000n,
      });
    const mockContract = {
      version: jest.fn<() => Promise<number>>().mockResolvedValue(8),
      useCollateralPool: jest.fn().mockReturnValue(false),
      linkedToken: jest.fn().mockReturnValue(tradingPairConfig.baseToken),
      investmentToken: jest.fn().mockReturnValue(tradingPairConfig.quoteToken),
      isBuyLow: jest.fn().mockReturnValue(true),
      quantity: jest.fn().mockReturnValue(15000000000),
      depositTotal: jest.fn().mockReturnValue(250000000n),
      linkedPrice: jest.fn().mockReturnValue(2500000000n),
      yieldValue: jest.fn().mockReturnValue(60000000000000000n),
      tradingFeeRate: jest.fn().mockReturnValue(20000000000000000n),
      oraclePriceAtCreation: jest.fn().mockReturnValue(260000000000n),
      ownerDepositLinkedTokenAmount: jest
        .fn()
        .mockReturnValue(6360000000000000000n),
      ownerDepositInvestmentTokenAmount: jest.fn().mockReturnValue(918000000n),
      balanceOf: jest.fn().mockReturnValue(900000000000000000000000000n),
      allowance: jest.fn().mockReturnValue(0n),
      name: jest.fn().mockReturnValue("ETH"),
      approve: buildTxFn(),
      adjustYieldValue: buildTxFn(),
      execute: buildTxFn(),
    };
    jest
      .spyOn(ethers, "Contract")
      .mockReturnValue(mockContract as unknown as ethers.Contract);

    const vaultManager = newVaultManager();
    await vaultManager.adjustVaultYield(mockVaultAddress, "12.0");

    expect(mockContract.execute).toHaveBeenCalledTimes(1);
    expect(mockContract.approve).not.toHaveBeenCalled();
    expect(mockContract.adjustYieldValue).not.toHaveBeenCalled();
    expect(mockConsoleLog).toHaveBeenCalledWith(
      `Vault ${mockVaultAddress} yield adjusted to 12.0% successfully`,
    );

    const [mode, executionCalldata, overrides] = mockContract.execute.mock
      .calls[0] as [string, string, { value: bigint }];
    expect(mode).toBe(ERC7579_BATCH_MODE);
    expect(overrides.value).toBe(0n);
    const calls = decodeBatchCalls(executionCalldata);
    expect(calls.length).toBe(3);

    expect(calls[0].target).toBe(tradingPairConfig.baseToken);
    const linkedApprove = erc20Interface.parseTransaction({
      data: calls[0].callData,
    });
    expect(linkedApprove?.args[0]).toBe(mockVaultAddress);
    expect(linkedApprove?.args[1]).toBe(342000000000000000n);

    expect(calls[1].target).toBe(tradingPairConfig.quoteToken);
    const investmentApprove = erc20Interface.parseTransaction({
      data: calls[1].callData,
    });
    expect(investmentApprove?.args[0]).toBe(mockVaultAddress);
    expect(investmentApprove?.args[1]).toBe(872100000n);

    expect(calls[2].target).toBe(mockVaultAddress);
    expect(calls[2].value).toBe(0n);
    const adjust = vaultInterface.parseTransaction({ data: calls[2].callData });
    expect(adjust?.name).toBe("adjustYieldValue");
    expect(adjust?.args[0]).toBe(120000000000000000n);
  });
});

describe("VaultManager subscribeVault", () => {
  const depositSignatures = new ethers.Interface(RouterAbi).fragments
    .filter((fragment) => fragment.type === "function")
    .map((fragment) => fragment.format())
    .filter((signature) => signature.startsWith("deposit("));
  const withDepositOverloads = (mockContract: { deposit: unknown }) => {
    for (const signature of depositSignatures) {
      (mockContract as Record<string, unknown>)[signature] =
        mockContract.deposit;
    }
  };

  afterEach(() => {
    jest.clearAllMocks();
  });

  const vaultManager = new VaultManager(mockConfig, mockBasicSettings);
  const mockSignature =
    "0xf586aa3beda79685309b5b27b3213398446a9bd3fb40e4131bcd16583d85136b152021da9151ca3fb6068afe2b2ad67641d120025ecac4e00fb2d61a64d7a5731c";

  test("subscribe to vault successfully", async () => {
    const mockDepositWait = jest
      .fn<() => Promise<object>>()
      .mockResolvedValue({ status: 1 });

    const mockApproveWait = jest
      .fn<() => Promise<object>>()
      .mockResolvedValue({ status: 1 });

    const mockContract = {
      investmentToken: jest.fn().mockReturnValue(tradingPairConfig.quoteToken),
      linkedToken: jest.fn().mockReturnValue(tradingPairConfig.baseToken),
      decimals: jest.fn().mockReturnValue(6),
      deposit: (() => {
        const fn = jest.fn().mockReturnValue({
          wait: mockDepositWait,
        });
        (fn as any).staticCall = jest
          .fn()
          .mockImplementation(() => Promise.resolve());
        return fn;
      })(),
      approve: (() => {
        const fn = jest.fn().mockReturnValue({
          wait: mockApproveWait,
        });
        (fn as any).staticCall = jest
          .fn()
          .mockImplementation(() => Promise.resolve());
        return fn;
      })(),
      balanceOf: jest.fn().mockReturnValue(9000000000000000n),
      allowance: jest
        .fn()
        .mockReturnValueOnce(0n)
        .mockReturnValue(1000000000000000000000000n),
      name: jest.fn().mockReturnValue("ETH"),
      isBuyLow: jest.fn().mockReturnValue(true),
      symbol: jest.fn().mockReturnValueOnce("WETH").mockReturnValueOnce("USDC"),
      getUpdateFee: jest.fn().mockReturnValue(1n),
    };

    withDepositOverloads(mockContract);
    const spyContract = jest
      .spyOn(ethers, "Contract")
      .mockReturnValue(mockContract as unknown as ethers.Contract);

    const spyPythConnection = jest
      .spyOn(vaultManager.pythConnection, "getLatestPriceUpdates")
      .mockResolvedValue({
        binary: {
          encoding: "hex",
          data: [mockHexData],
        },
        parsed: mockedParsedData,
      });

    await vaultManager.subscribeVault(mockVaultAddress, "1");

    expect(spyContract).toHaveBeenNthCalledWith(
      1,
      mockVaultAddress,
      VaultCoreABI,
      mockSigner,
    );

    expect(spyContract).toHaveBeenNthCalledWith(
      2,
      tradingPairConfig.baseToken,
      IERC20ABI,
      mockSigner,
    );

    expect(spyContract).toHaveBeenNthCalledWith(
      3,
      tradingPairConfig.quoteToken,
      IERC20ABI,
      mockSigner,
    );

    expect(spyContract).toHaveBeenNthCalledWith(
      4,
      mockConfig.pythPriceFeed,
      IPythABI,
      mockSigner,
    );

    expect(spyContract).toHaveBeenNthCalledWith(
      5,
      mockConfig.router,
      RouterAbi,
      mockSigner,
    );

    expect(mockContract.approve).toHaveBeenCalledWith(
      mockConfig.router,
      "1000000",
    );

    expect(mockContract.deposit).toHaveBeenCalledWith(
      mockVaultAddress,
      "1000000",
      0,
      [Buffer.from(mockHexData, "hex")],
      { value: 1n },
    );

    expect(mockApproveWait).toHaveBeenCalledTimes(1);
    expect(mockDepositWait).toHaveBeenCalledTimes(1);
  });

  test("ignores overflow panic in deposit simulation", async () => {
    const mockDepositWait = jest
      .fn<() => Promise<object>>()
      .mockResolvedValue({ status: 1 });

    const mockContract = {
      investmentToken: jest.fn().mockReturnValue(tradingPairConfig.quoteToken),
      linkedToken: jest.fn().mockReturnValue(tradingPairConfig.baseToken),
      decimals: jest.fn().mockReturnValue(6),
      deposit: (() => {
        const fn = jest.fn().mockReturnValue({
          wait: mockDepositWait,
        });
        (fn as any).staticCall = jest
          .fn()
          .mockImplementation(() =>
            Promise.reject({ reason: "Panic due to OVERFLOW(17)" }),
          );
        return fn;
      })(),
      balanceOf: jest.fn().mockReturnValue(9000000000000000n),
      allowance: jest.fn().mockReturnValue(1000000000000000000000000n),
      name: jest.fn().mockReturnValue("ETH"),
      isBuyLow: jest.fn().mockReturnValue(true),
      symbol: jest.fn().mockReturnValueOnce("WETH").mockReturnValueOnce("USDC"),
      getUpdateFee: jest.fn().mockReturnValue(1n),
    };

    withDepositOverloads(mockContract);
    jest
      .spyOn(ethers, "Contract")
      .mockReturnValue(mockContract as unknown as ethers.Contract);
    jest
      .spyOn(vaultManager.pythConnection, "getLatestPriceUpdates")
      .mockResolvedValue({
        binary: {
          encoding: "hex",
          data: [mockHexData],
        },
        parsed: mockedParsedData,
      });

    await vaultManager.subscribeVault(mockVaultAddress, "1");

    expect((mockContract.deposit as any).staticCall).toHaveBeenCalledTimes(1);
    expect(mockContract.deposit).toHaveBeenCalledWith(
      mockVaultAddress,
      "1000000",
      0,
      [Buffer.from(mockHexData, "hex")],
      { value: 1n },
    );
    expect(mockDepositWait).toHaveBeenCalledTimes(1);
  });

  test("subscribe to signature-required vault successfully", async () => {
    const mockDepositWait = jest
      .fn<() => Promise<object>>()
      .mockResolvedValue({ status: 1 });

    const mockApproveWait = jest
      .fn<() => Promise<object>>()
      .mockResolvedValue({ status: 1 });

    const mockContract = {
      investmentToken: jest.fn().mockReturnValue(tradingPairConfig.quoteToken),
      linkedToken: jest.fn().mockReturnValue(tradingPairConfig.baseToken),
      decimals: jest.fn().mockReturnValue(6),
      deposit: (() => {
        const fn = jest.fn().mockReturnValue({
          wait: mockDepositWait,
        });
        (fn as any).staticCall = jest
          .fn()
          .mockImplementation(() => Promise.resolve());
        return fn;
      })(),
      approve: (() => {
        const fn = jest.fn().mockReturnValue({
          wait: mockApproveWait,
        });
        (fn as any).staticCall = jest
          .fn()
          .mockImplementation(() => Promise.resolve());
        return fn;
      })(),
      balanceOf: jest.fn().mockReturnValue(9000000000000000n),
      allowance: jest
        .fn()
        .mockReturnValueOnce(0n)
        .mockReturnValue(1000000000000000000000000n),
      name: jest.fn().mockReturnValue("ETH"),
      isBuyLow: jest.fn().mockReturnValue(true),
      yieldValue: jest.fn().mockReturnValue(10000000000000000n),
      symbol: jest.fn().mockReturnValueOnce("WETH").mockReturnValueOnce("USDC"),
      getUpdateFee: jest.fn().mockReturnValue(1n),
    };

    withDepositOverloads(mockContract);
    jest
      .spyOn(ethers, "Contract")
      .mockReturnValue(mockContract as unknown as ethers.Contract);

    jest
      .spyOn(vaultManager.pythConnection, "getLatestPriceUpdates")
      .mockResolvedValue({
        binary: {
          encoding: "hex",
          data: [mockHexData],
        },
        parsed: mockedParsedData,
      });

    await vaultManager.subscribeVault(mockVaultAddress, "1", {
      signature: mockSignature,
      signedYieldValue: "10000000000000000",
      nonce: "123",
      deadline: "1747262316",
    });

    expect(mockContract.deposit).toHaveBeenCalledWith(
      mockVaultAddress,
      "1000000",
      "10000000000000000",
      "123",
      "1747262316",
      mockSignature,
      0,
      [Buffer.from(mockHexData, "hex")],
      { value: 1n },
    );
    expect(mockApproveWait).toHaveBeenCalledTimes(1);
    expect(mockDepositWait).toHaveBeenCalledTimes(1);
  });
});

describe("VaultManager withdrawVault", () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  const mockWithdrawWait = jest
    .fn<() => Promise<object>>()
    .mockResolvedValue({ status: 1 });

  const mockGetUpdateFeeWait = jest
    .fn<() => Promise<Number>>()
    .mockResolvedValue(1);

  const mockWithdrawContract = {
    owner: jest.fn().mockReturnValue(mockConfig.account),
    isBuyLow: jest.fn().mockReturnValue(true),
    state: jest.fn().mockReturnValue(1),
    investmentToken: jest.fn().mockReturnValue(tradingPairConfig.quoteToken),
    linkedToken: jest.fn().mockReturnValue(tradingPairConfig.baseToken),
    expiry: jest.fn().mockReturnValue(mockBuyLowVaultOptions.expiry),
    withdrawalUnlockTime: jest
      .fn<() => Promise<unknown>>()
      .mockResolvedValue(mockBuyLowVaultOptions.expiry + 7200),
    balances: jest.fn().mockReturnValue("1"),
    balanceOf: jest.fn().mockReturnValue("1"),
    version: jest.fn<() => Promise<number>>().mockResolvedValue(8), // Series 1 vault, version 8
    withdraw: (() => {
      const fn = jest.fn().mockReturnValue(mockWithdrawWait);
      (fn as any).staticCall = jest
        .fn()
        .mockImplementation(() => Promise.resolve());
      return fn;
    })(),
    lpWithdraw: (() => {
      const fn = jest.fn().mockReturnValue(mockWithdrawWait);
      (fn as any).staticCall = jest
        .fn()
        .mockImplementation(() => Promise.resolve());
      return fn;
    })(),
    getUpdateFee: jest.fn().mockReturnValue({ mockGetUpdateFeeWait }),
  };

  const vaultManager = new VaultManager(mockConfig, mockBasicSettings);

  test("LP withdraw with state 1 vault successfully", async () => {
    const mockContract = {
      ...mockWithdrawContract,
      state: jest.fn().mockReturnValue(1),
      symbol: jest.fn().mockReturnValueOnce("WETH").mockReturnValueOnce("USDC"),
    };

    const spyContract = jest
      .spyOn(ethers, "Contract")
      .mockReturnValue(mockContract as unknown as ethers.Contract);

    const spyPythConnection = jest
      .spyOn(vaultManager.pythConnection, "getPriceUpdatesAtTimestamp")
      .mockResolvedValue({
        binary: {
          encoding: "hex",
          data: [mockHexData],
        },
        parsed: mockedParsedData,
      });

    await vaultManager.withdrawVault(mockVaultAddress, true);

    expect(spyContract).toHaveBeenCalledTimes(4);
    expect(spyContract).toHaveBeenNthCalledWith(
      1,
      mockVaultAddress,
      VaultABI,
      mockSigner,
    );
    expect(spyContract).toHaveBeenNthCalledWith(
      2,
      tradingPairConfig.baseToken,
      IERC20ABI,
      mockSigner,
    );
    expect(spyContract).toHaveBeenNthCalledWith(
      3,
      tradingPairConfig.quoteToken,
      IERC20ABI,
      mockSigner,
    );
    expect(spyContract).toHaveBeenNthCalledWith(
      4,
      mockConfig.pythPriceFeed,
      IPythABI,
      mockSigner,
    );

    expect(mockContract.balanceOf).toHaveBeenCalledWith(mockVaultAddress);
    expect(mockContract.lpWithdraw).toHaveBeenCalledTimes(1);
  });

  test("LP withdraw with state 2 vault successfully", async () => {
    const mockContract = {
      ...mockWithdrawContract,
      state: jest.fn().mockReturnValue(2),
      symbol: jest.fn().mockReturnValueOnce("WETH").mockReturnValueOnce("USDC"),
    };

    const spyContract = jest
      .spyOn(ethers, "Contract")
      .mockReturnValue(mockContract as unknown as ethers.Contract);

    const spyPythConnection = jest
      .spyOn(vaultManager.pythConnection, "getPriceUpdatesAtTimestamp")
      .mockResolvedValue({
        binary: {
          encoding: "hex",
          data: [mockHexData],
        },
        parsed: mockedParsedData,
      });

    await vaultManager.withdrawVault(mockVaultAddress, true);

    expect(spyContract).toHaveBeenCalledTimes(4);
    expect(spyContract).toHaveBeenNthCalledWith(
      1,
      mockVaultAddress,
      VaultABI,
      mockSigner,
    );
    expect(spyContract).toHaveBeenNthCalledWith(
      2,
      tradingPairConfig.baseToken,
      IERC20ABI,
      mockSigner,
    );
    expect(spyContract).toHaveBeenNthCalledWith(
      3,
      tradingPairConfig.quoteToken,
      IERC20ABI,
      mockSigner,
    );
    expect(spyContract).toHaveBeenNthCalledWith(
      4,
      mockConfig.pythPriceFeed,
      IPythABI,
      mockSigner,
    );

    expect(mockContract.balanceOf).toHaveBeenCalledWith(mockVaultAddress);
    expect(mockContract.lpWithdraw).toHaveBeenCalledTimes(1);
  });

  test("Subscriber withdraw vault successfully", async () => {
    const mockContract = {
      ...mockWithdrawContract,
      owner: jest
        .fn()
        .mockReturnValue("0x0000000000000000000000000000000000000000"),
      symbol: jest.fn().mockReturnValueOnce("WETH").mockReturnValueOnce("USDC"),
    };

    const spyContract = jest
      .spyOn(ethers, "Contract")
      .mockReturnValue(mockContract as unknown as ethers.Contract);

    const spyPythConnection = jest
      .spyOn(vaultManager.pythConnection, "getPriceUpdatesAtTimestamp")
      .mockResolvedValue({
        binary: {
          encoding: "hex",
          data: [mockHexData],
        },
        parsed: mockedParsedData,
      });

    await vaultManager.withdrawVault(mockVaultAddress, false);

    expect(spyContract).toHaveBeenNthCalledWith(
      1,
      mockVaultAddress,
      VaultABI,
      mockSigner,
    );

    expect(mockContract.balances).toHaveBeenCalledWith(
      await vaultManager.signer.getAddress(),
    );

    expect(mockContract.withdraw).toHaveBeenCalledTimes(1);
  });

  test("Subscriber withdraw v2 vault checks CollateralPoolV2 balance", async () => {
    const mockContract = {
      ...mockWithdrawContract,
      owner: jest
        .fn()
        .mockReturnValue("0x0000000000000000000000000000000000000000"),
      state: jest.fn().mockReturnValue(2),
      version: jest.fn<() => Promise<number>>().mockResolvedValue(208), // Series 2 vault
      // V2 subscriber balances live in CollateralPoolV2
      userVaultBalance: jest.fn<() => Promise<object>>().mockResolvedValue({
        principal: "100",
        linkedTokenTotal: "0",
        investmentTokenYield: "0",
      }),
      balances: jest.fn(),
      symbol: jest.fn().mockReturnValueOnce("WETH").mockReturnValueOnce("USDC"),
    };

    jest
      .spyOn(ethers, "Contract")
      .mockReturnValue(mockContract as unknown as ethers.Contract);
    jest
      .spyOn(vaultManager.pythConnection, "getPriceUpdatesAtTimestamp")
      .mockResolvedValue({
        binary: { encoding: "hex", data: [mockHexData] },
        parsed: mockedParsedData,
      });

    await vaultManager.withdrawVault(mockVaultAddress, false);

    expect(mockContract.balances).not.toHaveBeenCalled();
    expect(mockContract.userVaultBalance).toHaveBeenCalledWith(
      mockVaultAddress,
      await vaultManager.signer.getAddress(),
    );
    expect(mockContract.withdraw).toHaveBeenCalledTimes(1);
  });

  test("Subscriber withdraw v2 vault with zero balance is skipped", async () => {
    const mockContract = {
      ...mockWithdrawContract,
      owner: jest
        .fn()
        .mockReturnValue("0x0000000000000000000000000000000000000000"),
      state: jest.fn().mockReturnValue(2),
      version: jest.fn<() => Promise<number>>().mockResolvedValue(208), // Series 2 vault
      // nothing to withdraw
      userVaultBalance: jest.fn<() => Promise<object>>().mockResolvedValue({
        principal: "0",
        linkedTokenTotal: "0",
        investmentTokenYield: "0",
      }),
      symbol: jest.fn().mockReturnValueOnce("WETH").mockReturnValueOnce("USDC"),
    };

    jest
      .spyOn(ethers, "Contract")
      .mockReturnValue(mockContract as unknown as ethers.Contract);
    jest
      .spyOn(vaultManager.pythConnection, "getPriceUpdatesAtTimestamp")
      .mockResolvedValue({
        binary: { encoding: "hex", data: [mockHexData] },
        parsed: mockedParsedData,
      });

    await vaultManager.withdrawVault(mockVaultAddress, false);

    expect(mockContract.userVaultBalance).toHaveBeenCalled();
    expect(mockContract.withdraw).not.toHaveBeenCalled();
  });

  test("V2 vault LP withdraw will be skipped", async () => {
    const mockContract = {
      ...mockWithdrawContract,
      owner: jest.fn().mockReturnValue(mockConfig.account), // LP
      version: jest.fn<() => Promise<number>>().mockResolvedValue(208), // Series 2 vault
      symbol: jest.fn().mockReturnValueOnce("WETH").mockReturnValueOnce("USDC"),
    };

    jest
      .spyOn(ethers, "Contract")
      .mockReturnValue(mockContract as unknown as ethers.Contract);
    jest
      .spyOn(vaultManager.pythConnection, "getPriceUpdatesAtTimestamp")
      .mockResolvedValue({
        binary: { encoding: "hex", data: [mockHexData] },
        parsed: mockedParsedData,
      });

    await vaultManager.withdrawVault(mockVaultAddress, true);

    expect(mockContract.lpWithdraw).not.toHaveBeenCalled();
  });

  test("Older vault falls back to V1 path", async () => {
    const mockContract = {
      ...mockWithdrawContract,
      owner: jest
        .fn()
        .mockReturnValue("0x0000000000000000000000000000000000000000"),
      // Older vaults calls reject
      withdrawalUnlockTime: jest
        .fn<() => Promise<number>>()
        .mockRejectedValue(new Error("missing revert data")),
      version: jest
        .fn<() => Promise<number>>()
        .mockRejectedValue(new Error("missing revert data")),
      expiry: jest.fn().mockReturnValue(mockBuyLowVaultOptions.expiry),
      symbol: jest.fn().mockReturnValueOnce("WETH").mockReturnValueOnce("USDC"),
    };

    jest
      .spyOn(ethers, "Contract")
      .mockReturnValue(mockContract as unknown as ethers.Contract);
    jest
      .spyOn(vaultManager.pythConnection, "getPriceUpdatesAtTimestamp")
      .mockResolvedValue({
        binary: { encoding: "hex", data: [mockHexData] },
        parsed: mockedParsedData,
      });

    // withdrawalUnlockTime falls back to expiry,
    // version falls back to seriesVersion 0 (V1 path)
    await vaultManager.withdrawVault(mockVaultAddress, false);

    expect(mockContract.balances).toHaveBeenCalled();
    expect(mockContract.withdraw).toHaveBeenCalledTimes(1);
  });
});

describe("VaultManager groupVaultsByTradingPairAndExpiry", () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  const vaultManager = new VaultManager(mockConfig, mockBasicSettings);

  test("should group vaults correctly by trading pair and expiry", async () => {
    const mockVaultData = [
      {
        vault_address: "0x123",
        tradingPair: "ETH-USDC",
        expiry: "1731657600",
        isLp: true,
      },
      {
        vault_address: "0x456",
        tradingPair: "ETH-USDC",
        expiry: "1731657600",
        isLp: true,
      },
      {
        vault_address: "0x789",
        tradingPair: "BTC-USDC",
        expiry: "1731657600",
        isLp: false,
      },
      {
        vault_address: "0xabc",
        tradingPair: "ETH-USDC",
        expiry: "1742284800",
        isLp: true,
      },
    ];

    const result =
      await vaultManager.groupVaultsByTradingPairAndExpiry(mockVaultData);

    expect(Object.keys(result).length).toBe(3);
    expect(result["ETH-USDC-1731657600-lp"].vaults.length).toBe(2);
    expect(result["BTC-USDC-1731657600-subscriber"].vaults.length).toBe(1);
    expect(result["ETH-USDC-1742284800-lp"].vaults.length).toBe(1);

    expect(result["ETH-USDC-1731657600-lp"].tradingPair).toBe("ETH-USDC");
    expect(result["ETH-USDC-1731657600-lp"].expiry).toBe("1731657600");
    expect(result["ETH-USDC-1731657600-lp"].isLp).toBe(true);
  });
});

describe("VaultManager withdrawMultipleVaults", () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  const mockWaitResult = {
    hash: "0x123hash",
  };

  const mockLpWithdrawVaultsWait = jest
    .fn<() => Promise<object>>()
    .mockResolvedValue(mockWaitResult);

  const mockWithdrawVaultsWait = jest
    .fn<() => Promise<object>>()
    .mockResolvedValue(mockWaitResult);

  const mockVaultBatchManagerContract = {
    lpWithdrawVaults: (() => {
      const fn = jest.fn().mockReturnValue({ wait: mockLpWithdrawVaultsWait });
      (fn as any).staticCall = jest
        .fn()
        .mockImplementation(() => Promise.resolve());
      return fn;
    })(),
    withdrawVaults: (() => {
      const fn = jest.fn().mockReturnValue({ wait: mockWithdrawVaultsWait });
      (fn as any).staticCall = jest
        .fn()
        .mockImplementation(() => Promise.resolve());
      return fn;
    })(),
  };

  const mockPythPriceFeedContract = {
    getUpdateFee: jest.fn().mockReturnValue("1"),
  };

  const mockVaultContract = {
    expiry: jest.fn().mockReturnValue("1731657600"),
    withdrawalUnlockTime: jest
      .fn<() => Promise<unknown>>()
      .mockResolvedValue("1731664800"), // expiry + 2 hours
    owner: jest.fn().mockReturnValue(mockConfig.account),
    investmentToken: jest.fn().mockReturnValue(tradingPairConfig.quoteToken),
    linkedToken: jest.fn().mockReturnValue(tradingPairConfig.baseToken),
    state: jest.fn().mockReturnValue(1),
    balances: jest.fn().mockReturnValue("100"),
    isBuyLow: jest.fn().mockReturnValue(true),
    version: jest.fn<() => Promise<number>>().mockResolvedValue(8), // Series 1 vault, version 8
    useCollateralPool: jest.fn().mockReturnValue(false),
    depositTotal: jest.fn().mockReturnValue("100"),
  };

  const mockTokenContract = {
    balanceOf: jest.fn().mockReturnValue("100"),
    symbol: jest.fn().mockReturnValueOnce("USDC").mockReturnValueOnce("WETH"),
  };

  const vaultManager = new VaultManager(mockConfig, mockBasicSettings);

  test("should process LP vaults correctly", async () => {
    const vaultAddresses = ["0xvault1", "0xvault2"];

    // Mock contract creation
    const spyContract = jest
      .spyOn(ethers, "Contract")
      .mockImplementation((address, abi, signer) => {
        if (address === mockConfig.vaultBatchManager) {
          return mockVaultBatchManagerContract as unknown as ethers.Contract;
        } else if (address === mockConfig.pythPriceFeed) {
          return mockPythPriceFeedContract as unknown as ethers.Contract;
        } else if (
          address === tradingPairConfig.quoteToken ||
          address === tradingPairConfig.baseToken
        ) {
          return mockTokenContract as unknown as ethers.Contract;
        } else {
          return mockVaultContract as unknown as ethers.Contract;
        }
      });

    const spyGetTradingPair = jest
      .spyOn(vaultManager as any, "_getTradingPairOfVault")
      .mockResolvedValue("ETH-USDC");

    // Mock groupVaultsByTradingPairAndExpiry
    const mockGroupedVaults = {
      "ETH-USDC-1731657600-lp": {
        vaults: [
          {
            vault_address: "0xvault1",
            tradingPair: "ETH-USDC",
            expiry: "1731657600",
            isLp: true,
          },
          {
            vault_address: "0xvault2",
            tradingPair: "ETH-USDC",
            expiry: "1731657600",
            isLp: true,
          },
        ],
        tradingPair: "ETH-USDC",
        expiry: "1731657600",
        isLp: true,
      },
    };

    const spyGroupVaults = jest
      .spyOn(vaultManager, "groupVaultsByTradingPairAndExpiry")
      .mockResolvedValue(mockGroupedVaults);

    // Mock _getHermesPriceUpdateAtTimestamp
    const spyGetPriceUpdate = jest
      .spyOn(vaultManager as any, "_getHermesPriceUpdateAtTimestamp")
      .mockResolvedValue({
        binary: {
          encoding: "hex",
          data: [mockHexData],
        },
        parsed: mockedParsedData,
      });

    await vaultManager.withdrawMultipleVaults(vaultAddresses, true);

    expect(mockPythPriceFeedContract.getUpdateFee).toHaveBeenCalledTimes(1);

    // Verify vault contracts were created for each address
    expect(spyContract).toHaveBeenCalledWith("0xvault1", VaultABI, mockSigner);
    expect(spyContract).toHaveBeenCalledWith("0xvault2", VaultABI, mockSigner);

    // Verify groupVaultsByTradingPairAndExpiry was called
    expect(spyGetTradingPair).toHaveBeenCalledTimes(2);
    expect(spyGroupVaults).toHaveBeenCalledTimes(1);

    // Verify _getHermesPriceUpdateAtTimestamp was called
    expect(spyGetPriceUpdate).toHaveBeenCalledTimes(1);
    expect(spyGetPriceUpdate).toHaveBeenCalledWith(
      parseInt("1731657600"),
      "ETH-USDC",
    );

    // Verify lpWithdrawVaults was called with correct parameters
    expect(mockPythPriceFeedContract.getUpdateFee).toHaveBeenCalledTimes(1);
    expect(mockVaultBatchManagerContract.lpWithdrawVaults).toHaveBeenCalledWith(
      ["0xvault1", "0xvault2"],
      [expect.any(Buffer)],
      {
        pythPublishTime: parseInt("1731657600"),
        pythMinConfidenceRatio: 0,
        chainlinkUseLatestAnswer: false,
        chainlinkRoundId: 0,
      },
      {
        value: expect.any(BigInt),
      },
    );
  });

  test("should process subscriber vaults correctly", async () => {
    const vaultAddresses = ["0xvault3", "0xvault4"];

    // Mock contract creation
    const spyContract = jest
      .spyOn(ethers, "Contract")
      .mockImplementation((address, abi, signer) => {
        if (address === mockConfig.vaultBatchManager) {
          return mockVaultBatchManagerContract as unknown as ethers.Contract;
        } else if (address === mockConfig.pythPriceFeed) {
          return mockPythPriceFeedContract as unknown as ethers.Contract;
        } else if (
          address === tradingPairConfig.quoteToken ||
          address === tradingPairConfig.baseToken
        ) {
          return mockTokenContract as unknown as ethers.Contract;
        } else {
          // For subscriber vaults, owner should be different from account
          return {
            ...mockVaultContract,
            owner: jest.fn().mockReturnValue("0xdifferentOwner"),
          } as unknown as ethers.Contract;
        }
      });

    // Mock groupVaultsByTradingPairAndExpiry
    const mockGroupedVaults = {
      "BTC-USDC-1731657600-subscriber": {
        vaults: [
          {
            vault_address: "0xvault3",
            tradingPair: "BTC-USDC",
            expiry: "1731657600",
            isLp: false,
          },
          {
            vault_address: "0xvault4",
            tradingPair: "BTC-USDC",
            expiry: "1731657600",
            isLp: false,
          },
        ],
        tradingPair: "BTC-USDC",
        expiry: "1731657600",
        isLp: false,
      },
    };

    const spyGetTradingPair = jest
      .spyOn(vaultManager as any, "_getTradingPairOfVault")
      .mockResolvedValue("BTC-USDC");

    const spyGroupVaults = jest
      .spyOn(vaultManager, "groupVaultsByTradingPairAndExpiry")
      .mockResolvedValue(mockGroupedVaults);

    // Mock _getHermesPriceUpdateAtTimestamp
    const spyGetPriceUpdate = jest
      .spyOn(vaultManager as any, "_getHermesPriceUpdateAtTimestamp")
      .mockResolvedValue({
        binary: {
          encoding: "hex",
          data: [mockHexData],
        },
        parsed: mockedParsedData,
      });

    await vaultManager.withdrawMultipleVaults(vaultAddresses, false);

    // Verify factory contract was called to get batch manager address
    expect(mockPythPriceFeedContract.getUpdateFee).toHaveBeenCalledTimes(1);

    // Verify vault contracts were created for each address
    expect(spyContract).toHaveBeenCalledWith("0xvault3", VaultABI, mockSigner);
    expect(spyContract).toHaveBeenCalledWith("0xvault4", VaultABI, mockSigner);

    // Verify groupVaultsByTradingPairAndExpiry was called
    expect(spyGetTradingPair).toHaveBeenCalledTimes(2);
    expect(spyGroupVaults).toHaveBeenCalledTimes(1);

    // Verify _getHermesPriceUpdateAtTimestamp was called
    expect(spyGetPriceUpdate).toHaveBeenCalledTimes(1);
    expect(spyGetPriceUpdate).toHaveBeenCalledWith(
      parseInt("1731657600"),
      "BTC-USDC",
    );

    // Verify withdrawVaults was called with correct parameters
    expect(mockVaultBatchManagerContract.withdrawVaults).toHaveBeenCalledTimes(
      1,
    );
    expect(mockVaultBatchManagerContract.withdrawVaults).toHaveBeenCalledWith(
      ["0xvault3", "0xvault4"],
      [expect.any(Buffer)],
      {
        pythPublishTime: parseInt("1731657600"),
        pythMinConfidenceRatio: 0,
        chainlinkUseLatestAnswer: false,
        chainlinkRoundId: 0,
      },
      {
        value: expect.any(BigInt),
      },
    );
  });
});

describe("VaultManager listAllVaults", () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  const vaultManager = new VaultManager(mockConfig, mockBasicSettings);

  test("list all vaults that created by the LP", async () => {
    const lpAddress = "0x9999999999999999999999999999999999999999";
    const otherLpAddress = "0x7777777777777777777777777777777777777777";

    const mockVaults = [
      "0x0000000000000000000000000000000000000001",
      "0x0000000000000000000000000000000000000002",
      "0x0000000000000000000000000000000000000003",
      "0x0000000000000000000000000000000000000004",
    ];

    const mockContract = {
      getDeployedVaults: jest.fn().mockReturnValue(mockVaults),
      getDeployedVaultCount: jest.fn().mockReturnValue(5),
      owner: jest
        .fn()
        .mockReturnValueOnce(lpAddress)
        .mockReturnValueOnce(lpAddress)
        .mockReturnValue(otherLpAddress),
    };

    const spyContract = jest
      .spyOn(ethers, "Contract")
      .mockReturnValue(mockContract as unknown as ethers.Contract);

    await vaultManager.listAllVaults(lpAddress);

    expect(spyContract).toHaveBeenNthCalledWith(
      1,
      mockConfig.factory,
      FactoryABI,
      mockSigner,
    );

    expect(mockContract.getDeployedVaults).toHaveBeenCalledWith(0n, 5n);

    const expectedVaults = mockVaults.slice(0, 2);
    const expectedFormattedAddresses = [
      "[",
      ...expectedVaults.map((address, idx) => {
        const suffix = idx === expectedVaults.length - 1 ? "" : ",";
        return `  '${address}'${suffix}`;
      }),
      "]",
    ].join("\n");

    expect(mockConsoleLog).toHaveBeenCalledWith(
      "Requesting vaults 0 to 4 (total deployed: 5).",
    );
    expect(mockConsoleLog).toHaveBeenCalledWith(
      `Vaults owned by ${lpAddress}:`,
    );
    expect(mockConsoleLog).toHaveBeenCalledWith(expectedFormattedAddresses);
  });
});

describe("VaultManager showVault", () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  const vaultManager = new VaultManager(mockConfig, mockBasicSettings);

  test("list parameters of a vault", async () => {
    const tradingPairConfig =
      mockConfig.tradingPairs[mockBuyLowVaultOptions.tradingPair];

    const mockVaultAddress = "0x0000000000000000000000000000000000000001";
    const mockTransactionHash =
      "0x20011e4f47e797f8854a902719fd5ccb477dae8e2dd6d60fd196cfcc07f3fc56";
    const mockBlockNumber = 17259837n;
    const mockCreationTimestamp = 1730287962n;

    const mockContract = {
      linkedOraclePrice: jest.fn().mockReturnValue(290000000000n),
      yieldValue: jest.fn().mockReturnValue(10000000000000000n),
      isBuyLow: jest.fn().mockReturnValue(true),
      investmentToken: jest.fn().mockReturnValue(tradingPairConfig.quoteToken),
      linkedToken: jest.fn().mockReturnValue(tradingPairConfig.baseToken),
      quantity: jest.fn().mockReturnValue(2000000n),
      state: jest.fn().mockReturnValue(0n),
      expiry: jest.fn().mockReturnValue(1730344973n),
      withdrawalUnlockTime: jest
        .fn<() => Promise<unknown>>()
        .mockResolvedValue(1730352173n), // expiry + 7200
      depositTotal: jest.fn().mockReturnValue(1000000n),
      decimals: jest.fn().mockReturnValue(6),
    };

    const spyContract = jest
      .spyOn(ethers, "Contract")
      .mockReturnValue(mockContract as unknown as ethers.Contract);

    const spyGetPastLogs = jest
      .spyOn(vaultManager.provider, "getLogs")
      .mockResolvedValue([
        {
          transactionHash: mockTransactionHash,
        },
      ] as any);

    const spyGetTransaction = jest
      .spyOn(vaultManager.provider, "getTransaction")
      .mockResolvedValue({
        blockNumber: mockBlockNumber,
      } as any);

    const spyGetBlock = jest
      .spyOn(vaultManager.provider, "getBlock")
      .mockResolvedValue({
        timestamp: mockCreationTimestamp,
      } as any);

    await vaultManager.showVault(mockVaultAddress);

    expect(spyContract).toHaveBeenNthCalledWith(
      1,
      mockVaultAddress,
      VaultABI,
      expect.anything(),
    );

    expect(spyGetPastLogs).toHaveBeenCalledWith({
      address: mockVaultAddress,
      fromBlock: 0,
      toBlock: "latest",
    });
    expect(spyGetTransaction).toHaveBeenCalledWith(mockTransactionHash);
    expect(spyGetBlock).toHaveBeenCalledWith(mockBlockNumber);

    expect(mockConsoleLog).toHaveBeenNthCalledWith(
      1,
      `Base token address: ${tradingPairConfig.baseToken}`,
    );
    expect(mockConsoleLog).toHaveBeenNthCalledWith(
      2,
      `Quote token address: ${tradingPairConfig.quoteToken}`,
    );
    expect(mockConsoleLog).toHaveBeenNthCalledWith(3, `Linked Price: 2900.0`);
    expect(mockConsoleLog).toHaveBeenNthCalledWith(4, `Yield: 1.0%`);
    expect(mockConsoleLog).toHaveBeenNthCalledWith(
      5,
      expect.stringMatching(/Creation Date:/),
    );
    expect(mockConsoleLog).toHaveBeenNthCalledWith(
      6,
      expect.stringMatching(/Expiry:/),
    );

    expect(mockConsoleLog).toHaveBeenNthCalledWith(7, `Direction: Buy Low`);
    expect(mockConsoleLog).toHaveBeenNthCalledWith(8, `Quantity: 2.0`);
    expect(mockConsoleLog).toHaveBeenNthCalledWith(
      9,
      `Remaining Quantity: 1.0`,
    );
    expect(mockConsoleLog).toHaveBeenNthCalledWith(10, `State: 0`);
  });
});

describe("VaultManager adjustVaultYield", () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  const vaultManager = new VaultManager(mockConfig, mockBasicSettings);

  test("adjust yield with collateral pool successfully", async () => {
    const mockAdjustYieldWait = jest
      .fn<() => Promise<object>>()
      .mockResolvedValue({ status: 1 });
    const mockContract: Record<string, object> = {
      adjustYieldValue: (() => {
        const fn = jest.fn().mockReturnValue({ wait: mockAdjustYieldWait });
        (fn as any).staticCall = jest
          .fn()
          .mockImplementation(() => Promise.resolve());
        return fn;
      })(),
      yieldValue: jest.fn<() => Promise<string>>().mockResolvedValue("0"),
      version: jest.fn<() => Promise<number>>().mockResolvedValue(208), // Series 2 vault, version 208 (2.08)
      useCollateralPool: jest.fn().mockReturnValue(true),
      isBuyLow: jest.fn().mockReturnValue(true),
      investmentToken: jest.fn().mockReturnValue(tradingPairConfig.quoteToken),
      linkedToken: jest.fn().mockReturnValue(tradingPairConfig.baseToken),
      quantity: jest.fn().mockReturnValue(2000000n),
      depositTotal: jest.fn().mockReturnValue(1000000n),
      linkedPrice: jest.fn().mockReturnValue(290000000000n),
    };
    const spyContract = jest
      .spyOn(ethers, "Contract")
      .mockReturnValue(mockContract as unknown as ethers.Contract);

    await vaultManager.adjustVaultYield(mockVaultAddress, "5.5");

    expect(spyContract).toHaveBeenCalledWith(
      mockVaultAddress,
      VaultABI,
      mockSigner,
    );

    expect(mockContract.adjustYieldValue).toHaveBeenCalledWith(
      "55000000000000000",
    );

    expect(mockAdjustYieldWait).toHaveBeenCalled();
    expect(mockConsoleLog).toHaveBeenCalledWith(
      `Vault ${mockVaultAddress} yield adjusted to 5.5% successfully`,
    );
  });

  test("adjust yield without collateral pool successfully", async () => {
    const mockAdjustYieldWait = jest
      .fn<() => Promise<object>>()
      .mockResolvedValue({ status: 1 });
    const mockApproveERC20 = jest
      .spyOn(vaultManager as any, "_approveERC20")
      .mockResolvedValue(undefined);
    // mock calculateTokenAmounts return
    const mockCalculateTokenAmounts = jest.spyOn(
      utils,
      "calculateTokenAmounts",
    );
    mockCalculateTokenAmounts
      .mockReturnValueOnce({
        linkedTokenAmount: 318000000000000000n, // 0.318 WETH
        investmentTokenAmount: 45900000n, // 45.9 USDC
      }) // currentDeposit
      .mockReturnValueOnce({
        linkedTokenAmount: 6384000000000000000n, // 6.384 WETH
        investmentTokenAmount: 1744200000n, // 174.42 USDC
      }); // remainingDeposit
    const mockContract: Record<string, object> = {
      adjustYieldValue: (() => {
        const fn = jest.fn().mockReturnValue({ wait: mockAdjustYieldWait });
        (fn as any).staticCall = jest
          .fn()
          .mockImplementation(() => Promise.resolve());
        return fn;
      })(),
      version: jest.fn<() => Promise<number>>().mockResolvedValue(8), // Series 1 vault, version 8 (1.08)
      useCollateralPool: jest.fn().mockReturnValue(false),
      linkedToken: jest.fn().mockReturnValue(tradingPairConfig.baseToken),
      investmentToken: jest.fn().mockReturnValue(tradingPairConfig.quoteToken),
      isBuyLow: jest.fn().mockReturnValue(true),
      quantity: jest.fn().mockReturnValue(15000000000), // 15000e6
      depositTotal: jest.fn().mockReturnValue(250000000n), // 250e6
      linkedPrice: jest.fn().mockReturnValue(2500000000n), // 2500e6
      linkedOraclePrice: jest.fn().mockReturnValue(250000000000n), // 2500e8
      yieldValue: jest.fn().mockReturnValue(60000000000000000n), // 6% = 6e16
      tradingFeeRate: jest.fn().mockReturnValue(20000000000000000n), // 2% = 2e16
      oraclePriceAtCreation: jest.fn().mockReturnValue(260000000000n), // 2600e8
      ownerDepositLinkedTokenAmount: jest
        .fn()
        .mockReturnValue(6360000000000000000n), // 6.36 WETH
      ownerDepositInvestmentTokenAmount: jest.fn().mockReturnValue(918000000n), // 91.8 USDC
    };
    const spyContract = jest
      .spyOn(ethers, "Contract")
      .mockReturnValue(mockContract as unknown as ethers.Contract);

    await vaultManager.adjustVaultYield(mockVaultAddress, "12.0");

    expect(spyContract).toHaveBeenCalledWith(
      mockVaultAddress,
      VaultABI,
      mockSigner,
    );

    // approveERC20 twice
    expect(mockApproveERC20).toHaveBeenCalledTimes(2);
    expect(mockApproveERC20).toHaveBeenNthCalledWith(
      1,
      expect.any(Object),
      mockVaultAddress,
      "342000000000000000",
    );
    expect(mockApproveERC20).toHaveBeenNthCalledWith(
      2,
      expect.any(Object),
      mockVaultAddress,
      "872100000",
    );
    expect(mockContract.adjustYieldValue).toHaveBeenCalledWith(
      "120000000000000000",
    );
    expect(mockAdjustYieldWait).toHaveBeenCalled();
    expect(mockConsoleLog).toHaveBeenCalledWith(
      `Vault ${mockVaultAddress} yield adjusted to 12.0% successfully`,
    );
  });
});

describe("VaultManager approveVault for collateral pool", () => {
  const vaultManager: VaultManager = new VaultManager(
    mockConfig,
    mockBasicSettings,
  );
  let mockApproveVault: jest.Mock;
  let mockApproveVaultInCollateralPoolWait: jest.Mock;
  let mockCollateralPoolContract: Record<string, object>;

  beforeEach(() => {
    jest.clearAllMocks();
    mockApproveVaultInCollateralPoolWait = jest
      .fn<() => Promise<object>>()
      .mockResolvedValue({ status: 1 });
    mockApproveVault = (() => {
      const fn = jest
        .fn()
        .mockReturnValue({ wait: mockApproveVaultInCollateralPoolWait });
      (fn as any).staticCall = jest
        .fn()
        .mockImplementation(() => Promise.resolve());
      return fn;
    })();
    mockCollateralPoolContract = {
      approveVault: mockApproveVault, // mock approveVault in collateral pool
    };
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  test("should call approveVault with true for series 2 vault using collateralPoolV2", async () => {
    const mockVaultContract = {
      version: jest.fn<() => Promise<number>>().mockResolvedValue(208), // Series 2 vault, version 208
      useCollateralPool: jest.fn().mockReturnValue(true),
    };
    const spyContract = jest
      .spyOn(ethers, "Contract")
      .mockReturnValueOnce(mockVaultContract as unknown as ethers.Contract)
      .mockReturnValueOnce(
        mockCollateralPoolContract as unknown as ethers.Contract,
      );

    await vaultManager.approveVault(mockVaultAddress, true);
    expect(spyContract).toHaveBeenCalledWith(
      mockVaultAddress,
      VaultABI,
      mockSigner,
    );
    expect(spyContract).toHaveBeenCalledWith(
      mockConfig.collateralPoolV2,
      CollateralPoolABI,
      mockSigner,
    );
    expect(mockApproveVault).toHaveBeenCalledWith(mockVaultAddress, true);
    expect(mockConsoleLog).toHaveBeenCalledWith(
      `CollateralPool approval for vault ${mockVaultAddress} succeeded!`,
    );
  });

  test("should call approveVault with true for series 1 vault using collateralPool", async () => {
    const mockVaultContract = {
      version: jest.fn<() => Promise<number>>().mockResolvedValue(8), // Series 1 vault, version 8
      useCollateralPool: jest.fn().mockReturnValue(true),
    };
    const spyContract = jest
      .spyOn(ethers, "Contract")
      .mockReturnValueOnce(mockVaultContract as unknown as ethers.Contract)
      .mockReturnValueOnce(
        mockCollateralPoolContract as unknown as ethers.Contract,
      );

    await vaultManager.approveVault(mockVaultAddress, true);
    expect(spyContract).toHaveBeenCalledWith(
      mockVaultAddress,
      VaultABI,
      mockSigner,
    );
    expect(spyContract).toHaveBeenCalledWith(
      mockConfig.collateralPool,
      CollateralPoolABI,
      mockSigner,
    );
    expect(mockApproveVault).toHaveBeenCalledWith(mockVaultAddress, true);
    expect(mockConsoleLog).toHaveBeenCalledWith(
      `CollateralPool approval for vault ${mockVaultAddress} succeeded!`,
    );
  });

  test("should call approveVault with false and log success", async () => {
    const mockVaultContract = {
      version: jest.fn<() => Promise<number>>().mockResolvedValue(208), // Series 2 vault, version 208
      useCollateralPool: jest.fn().mockReturnValue(true),
    };
    const spyContract = jest
      .spyOn(ethers, "Contract")
      .mockReturnValueOnce(mockVaultContract as unknown as ethers.Contract)
      .mockReturnValueOnce(
        mockCollateralPoolContract as unknown as ethers.Contract,
      );

    await vaultManager.approveVault(mockVaultAddress, false);
    expect(spyContract).toHaveBeenCalledWith(
      mockConfig.collateralPoolV2,
      CollateralPoolABI,
      mockSigner,
    );
    expect(mockApproveVault).toHaveBeenCalledWith(mockVaultAddress, false);
    expect(mockConsoleLog).toHaveBeenCalledWith(
      `CollateralPool disapproval for vault ${mockVaultAddress} succeeded!`,
    );
  });

  test("should log error if approveVault throws", async () => {
    mockApproveVaultInCollateralPoolWait.mockImplementation(() => {
      throw { shortMessage: "fail" };
    });
    const mockVaultContract = {
      version: jest.fn<() => Promise<number>>().mockResolvedValue(208), // Series 2 vault, version 208
      useCollateralPool: jest.fn().mockReturnValue(true),
    };
    const spyContract = jest
      .spyOn(ethers, "Contract")
      .mockReturnValueOnce(mockVaultContract as unknown as ethers.Contract)
      .mockReturnValueOnce(
        mockCollateralPoolContract as unknown as ethers.Contract,
      );

    await vaultManager.approveVault(mockVaultAddress, true);
    expect(spyContract).toHaveBeenCalledWith(
      mockConfig.collateralPoolV2,
      CollateralPoolABI,
      mockSigner,
    );
    expect(mockApproveVault).toHaveBeenCalledWith(mockVaultAddress, true);
    expect(mockConsoleError).toHaveBeenCalledWith(
      `CollateralPool approval for vault ${mockVaultAddress} failed!`,
    );
    expect(mockConsoleError).toHaveBeenCalledWith("fail");
  });

  test("should log error if vault is not using collateral pool", async () => {
    const mockVaultContract = {
      version: jest.fn<() => Promise<number>>().mockResolvedValue(8), // Series 1 vault, version 8
      useCollateralPool: jest.fn().mockReturnValue(false),
    };
    const spyContract = jest
      .spyOn(ethers, "Contract")
      .mockReturnValueOnce(mockVaultContract as unknown as ethers.Contract);

    await vaultManager.approveVault(mockVaultAddress, true);
    expect(spyContract).toHaveBeenCalledWith(
      mockVaultAddress,
      VaultABI,
      mockSigner,
    );
    expect(mockConsoleError).toHaveBeenCalledWith(
      `Vault ${mockVaultAddress} is not using collateral pool`,
    );
    expect(mockApproveVault).not.toHaveBeenCalled();
  });
});

describe("VaultManager _approveERC20", () => {
  afterEach(() => {
    jest.clearAllMocks();
    jest.useRealTimers();
  });

  const vaultManager = new VaultManager(mockConfig, mockBasicSettings);
  const spender = mockConfig.router;
  const amount = "1000000";

  const buildToken = (allowance: jest.Mock) => {
    const approveWait = jest
      .fn<() => Promise<object>>()
      .mockResolvedValue({ status: 1 });
    const token = {
      balanceOf: jest.fn().mockReturnValue(9000000n),
      allowance,
      name: jest.fn().mockReturnValue("USDC"),
      approve: (() => {
        const fn = jest.fn().mockReturnValue({ wait: approveWait });
        (fn as any).staticCall = jest
          .fn()
          .mockImplementation(() => Promise.resolve());
        return fn;
      })(),
    };
    return { token, approveWait };
  };

  test("skips the approve when the allowance already covers the amount", async () => {
    const { token, approveWait } = buildToken(
      jest.fn().mockReturnValue(1000000n),
    );

    await vaultManager._approveERC20(
      token as unknown as ethers.Contract,
      spender,
      amount,
    );

    expect(token.approve).not.toHaveBeenCalled();
    expect(approveWait).not.toHaveBeenCalled();
  });

  test("polls until the approved allowance is visible on the node", async () => {
    jest.useFakeTimers();
    const allowance = jest
      .fn()
      .mockReturnValueOnce(0n)
      .mockReturnValueOnce(0n)
      .mockReturnValueOnce(0n)
      .mockReturnValue(1000000n);
    const { token, approveWait } = buildToken(allowance);

    const pending = vaultManager._approveERC20(
      token as unknown as ethers.Contract,
      spender,
      amount,
    );
    await jest.advanceTimersByTimeAsync(5000);
    await pending;

    expect(token.approve).toHaveBeenCalledWith(spender, amount);
    expect(approveWait).toHaveBeenCalledTimes(1);
    expect(allowance.mock.calls.length).toBeGreaterThan(2);
  });

  test("throws when the allowance never becomes visible", async () => {
    jest.useFakeTimers();
    const { token } = buildToken(jest.fn().mockReturnValue(0n));

    const pending = vaultManager._approveERC20(
      token as unknown as ethers.Contract,
      spender,
      amount,
    );
    const assertion = expect(pending).rejects.toThrow(
      `USDC allowance for ${spender} is still not visible after approve; the RPC node may be lagging behind`,
    );
    await jest.advanceTimersByTimeAsync(60000);
    await assertion;
  });
});
