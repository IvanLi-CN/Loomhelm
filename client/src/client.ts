import { type ClientConfig, loadConfig } from './config.js';
import { Ledger } from './tasks/ledger.js';

export class LocalClient {
  private constructor(readonly config: ClientConfig, readonly ledger: Ledger) {}
  static async open(configPath?: string): Promise<LocalClient> {
    const config = await loadConfig(configPath);
    return new LocalClient(config, await Ledger.open(config.stateDir));
  }
  async close(): Promise<void> { await this.ledger.close(); }
}
