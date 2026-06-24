export class EvmRpc {
  constructor(url) {
    this.url = url;
    this.nextId = 1;
  }

  async call(method, params = []) {
    const response = await fetch(this.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: this.nextId++, method, params })
    });

    if (!response.ok) {
      throw new Error(`EVM RPC ${method} failed: ${response.status} ${response.statusText}`);
    }

    const payload = await response.json();
    if (payload.error) {
      throw new Error(`EVM RPC ${method} error: ${payload.error.message || JSON.stringify(payload.error)}`);
    }
    return payload.result;
  }

  async chainId() {
    return Number(BigInt(await this.call("eth_chainId")));
  }

  async blockNumber() {
    return BigInt(await this.call("eth_blockNumber"));
  }

  async ethCall(to, data, blockTag = "latest") {
    return this.call("eth_call", [{ to, data }, blockTag]);
  }

  async getLogs(filter) {
    return this.call("eth_getLogs", [filter]);
  }
}
