export const createVaultOperationDefinitions = [
  { name: "useCollateralPool", type: Boolean },
  { name: "isBuyLow", type: Boolean },
  { name: "linkedPrice", alias: "p", type: String },
  { name: "quantity", alias: "q", type: String },
  { name: "expiry", alias: "e", type: Number },
  { name: "yieldPercentage", alias: "y", type: String },
  { name: "tradingPair", alias: "t", type: String },
  { name: "signer", alias: "s", type: String },
  { name: "vaultSeriesVersion", type: Number },
  { name: "is7702Account", type: String },
];

export const subscribeVaultOperationDefinitions = [
  { name: "vault", alias: "v", type: String },
  { name: "amount", alias: "a", type: String },
  { name: "signature", alias: "s", type: String },
  { name: "signedYieldValue", type: String },
  { name: "nonce", type: String },
  { name: "deadline", alias: "d", type: String },
];

export const adjustVaultYieldOperationDefinitions = [
  { name: "vault", alias: "v", type: String },
  { name: "yieldPercentage", alias: "y", type: String },
];

export const approveVaultOperationDefinitions = [
  { name: "vault", alias: "v", type: String },
  { name: "approve", alias: "a", type: String },
];

export const simpleVaultOperationDefinitions = [
  { name: "vault", alias: "v", type: String },
];

export const multipleVaultOperationDefinitions = [
  { name: "vault", alias: "v", type: String, multiple: true },
  { name: "bypassCheck", alias: "b", type: Boolean },
];

export const addressOperationDefinitions = [
  { name: "address", alias: "a", type: String },
  { name: "start", alias: "s", type: Number },
  { name: "count", alias: "c", type: Number },
];
