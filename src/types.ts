export type TradingPair = {
  baseToken: string;
  quoteToken: string;
  priceFeed: {
    type: string;
    address?: string;
    id?: string;
    decimals: string;
  };
};

export type TradingPairs = { [key: string]: TradingPair };

export type BlockchainConfig = {
  rpcNode: string;
  account: string;
  is7702Account?: boolean;
  jsonWallet: string;
  passphrase: string;
  factory: string;
  router: string;
  vaultBatchManager: string;
  pythAggregator: string;
  pythPriceFeed: string;
  collateralPool: string;
  collateralPoolV2: string;
  tradingPairs: TradingPairs;
};

export type BasicSettings = {
  hermesApiBaseUrl: string;
  pythApiKey?: string;
};

export type VaultData = {
  vault_address: string;
  tradingPair: string;
  expiry: string;
  isLp: boolean;
};
