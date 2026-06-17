import {
  Configuration,
  RelayersApi,
  Speed,
  type EvmTransactionRequest,
  type NetworkTransactionRequest,
  type ApiResponseTransactionResponse,
  type ApiResponseTransactionResponseData,
} from "@openzeppelin/relayer-sdk";

type OzSpeed = "fastest" | "fast" | "average" | "safeLow";

function getEnv(name: string): string | undefined {
  const value = process.env[name];
  return value && value.trim().length > 0 ? value.trim() : undefined;
}

export function isOzRelayerEnabled(): boolean {
  return !!(
    getEnv("OZ_RELAYER_URL") &&
    getEnv("OZ_RELAYER_API_KEY") &&
    getEnv("OZ_RELAYER_ID")
  );
}

function toSpeed(speed?: string): Speed | undefined {
  if (!speed) return undefined;
  if (speed === "fastest") return Speed.FASTEST;
  if (speed === "fast") return Speed.FAST;
  if (speed === "average") return Speed.AVERAGE;
  if (speed === "safeLow") return Speed.SAFE_LOW;
  return undefined;
}

function toRelayerNumber(value: bigint | number, fieldName: string): number {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(
        `Relayer ${fieldName} must be a non-negative safe integer`,
      );
    }
    return value;
  }

  if (value < 0n) {
    throw new Error(`Relayer ${fieldName} must be a non-negative integer`);
  }

  const numberValue = Number(value);
  if (
    !Number.isFinite(numberValue) ||
    !Number.isInteger(numberValue) ||
    BigInt(numberValue) !== value
  ) {
    throw new Error(
      `Relayer ${fieldName} cannot be represented exactly as a number`,
    );
  }
  return numberValue;
}

export class OzRelayerClient {
  private readonly api: RelayersApi;
  private readonly relayerId: string;
  private readonly speed?: Speed;

  constructor() {
    const baseUrl = getEnv("OZ_RELAYER_URL");
    const apiKey = getEnv("OZ_RELAYER_API_KEY");
    const relayerId = getEnv("OZ_RELAYER_ID");
    const speedEnv = getEnv("OZ_RELAYER_SPEED") as OzSpeed | undefined;

    if (!baseUrl || !apiKey || !relayerId) {
      throw new Error(
        "OpenZeppelin Relayer env is not fully configured. Required: OZ_RELAYER_URL, OZ_RELAYER_API_KEY, OZ_RELAYER_ID",
      );
    }

    const config = new Configuration({
      basePath: baseUrl.replace(/\/+$/, ""),
      accessToken: apiKey,
    });

    this.api = new RelayersApi(config);
    this.relayerId = relayerId;
    this.speed = toSpeed(speedEnv);
  }

  async sendEvmTransaction(args: {
    to: string;
    data: string;
    value?: bigint;
    gasLimit?: bigint | number;
  }): Promise<{ id: string; hash?: string; status?: string }> {
    const body: EvmTransactionRequest = {
      to: args.to,
      data: args.data,
      value: toRelayerNumber(args.value ?? 0n, "value"),
    };
    if (args.gasLimit !== undefined) {
      body.gas_limit = toRelayerNumber(args.gasLimit, "gas_limit");
    }
    if (this.speed) {
      body.speed = this.speed;
    }

    console.log(
      `[relayer] sendEvmTransaction to=${args.to} value=${args.value ?? 0n} gasLimit=${args.gasLimit ?? "auto"}`,
    );
    const txRequest: NetworkTransactionRequest = body;
    const resp = await this.api.sendTransaction(this.relayerId, txRequest);
    const respData = resp.data as { data?: { id?: string }; id?: string };
    console.log(
      `[relayer] sendEvmTransaction submitted id=${respData?.data?.id ?? respData?.id ?? "unknown"}`,
    );
    return this.unwrapTransactionResponse(resp.data);
  }

  async cancelTransaction(transactionId: string): Promise<void> {
    try {
      await this.api.cancelTransaction(this.relayerId, transactionId);
      console.log(`[relayer] cancelTransaction sent for id=${transactionId}`);
    } catch (err) {
      console.warn(
        `[relayer] cancelTransaction failed for id=${transactionId}: ${String(err)}`,
      );
      throw err;
    }
  }

  async getTransaction(transactionId: string): Promise<{
    id: string;
    hash?: string;
    status?: string;
    status_reason?: string | null;
    nonce?: number;
    from?: string;
  }> {
    const resp = await this.api.getTransactionById(
      this.relayerId,
      transactionId,
    );
    return this.unwrapTransactionResponse(resp.data);
  }

  private unwrapTransactionResponse(response: ApiResponseTransactionResponse): {
    id: string;
    hash?: string;
    status?: string;
    status_reason?: string | null;
    nonce?: number;
    from?: string;
  } {
    const data = response.data as
      | ApiResponseTransactionResponseData
      | undefined;
    if (!data) {
      throw new Error("Relayer response missing data");
    }
    // data is EvmTransactionResponse | others; for EVM we expect id/status/hash fields
    const evmData = data as {
      id: string;
      hash?: string;
      status?: string;
      status_reason?: string | null;
      nonce?: number;
      from?: string;
    };
    return {
      id: evmData.id,
      hash: evmData.hash ?? undefined,
      status: evmData.status ?? undefined,
      status_reason: evmData.status_reason ?? undefined,
      nonce: evmData.nonce ?? undefined,
      from: evmData.from ?? undefined,
    };
  }
}
