import {
  expect,
  test,
  describe,
  jest,
  afterEach,
  beforeEach,
} from "@jest/globals";
import { OzRelayerClient } from "../src/oz_relayer_client";

const originalEnv = process.env;

type SendTransactionMock = (
  relayerId: string,
  request: unknown,
) => Promise<{ data: { data: { id: string; status: string } } }>;

function mockSendTransaction(client: OzRelayerClient) {
  const sendTransaction = jest.fn<SendTransactionMock>().mockResolvedValue({
    data: {
      data: {
        id: "tx-1",
        status: "pending",
      },
    },
  });
  (
    client as unknown as {
      api: { sendTransaction: typeof sendTransaction };
    }
  ).api.sendTransaction = sendTransaction;
  return sendTransaction;
}

describe("OzRelayerClient", () => {
  beforeEach(() => {
    process.env = {
      ...originalEnv,
      OZ_RELAYER_URL: "https://relayer.example/",
      OZ_RELAYER_API_KEY: "test-api-key",
      OZ_RELAYER_ID: "relayer-1",
    };
  });

  afterEach(() => {
    process.env = originalEnv;
    jest.clearAllMocks();
  });

  test("sends exactly representable large wei values through the SDK", async () => {
    const client = new OzRelayerClient();
    const sendTransaction = mockSendTransaction(client);

    const result = await client.sendEvmTransaction({
      to: "0x29ca87b2f744127606ada4564da8219be6498ca1",
      data: "0xabcdef",
      value: 25000000000000000n,
      gasLimit: 3000000,
    });

    expect(result).toEqual({ id: "tx-1", status: "pending" });
    expect(sendTransaction).toHaveBeenCalledWith("relayer-1", {
      to: "0x29ca87b2f744127606ada4564da8219be6498ca1",
      data: "0xabcdef",
      value: 25000000000000000,
      gas_limit: 3000000,
    });
  });

  test("rejects large wei values that would be rounded", async () => {
    const client = new OzRelayerClient();
    const sendTransaction = mockSendTransaction(client);

    await expect(
      client.sendEvmTransaction({
        to: "0x29ca87b2f744127606ada4564da8219be6498ca1",
        data: "0x",
        value: 25000000000000001n,
      }),
    ).rejects.toThrow(
      "Relayer value cannot be represented exactly as a number",
    );

    expect(sendTransaction).not.toHaveBeenCalled();
  });

  test("rejects negative transaction values before sending", async () => {
    const client = new OzRelayerClient();
    const sendTransaction = mockSendTransaction(client);

    await expect(
      client.sendEvmTransaction({
        to: "0x29ca87b2f744127606ada4564da8219be6498ca1",
        data: "0x",
        value: -1n,
      }),
    ).rejects.toThrow("Relayer value must be a non-negative integer");

    expect(sendTransaction).not.toHaveBeenCalled();
  });
});
