// secrets.ts: where credentials' secrets live (docs/design/host.md "What is kept where"). The host asks a
// SecretStore by (owner, name); the environment serves one owner, the credentials table serves many, and a
// vault is another implementation of the same two calls. Adapters never see names, only the material.

export type SecretStore = {
  get(owner: string, name: string): Promise<string | undefined>;
  /** Optional: a store that can be written to (the table can; the environment can't). */
  set?(owner: string, name: string, value: string): Promise<void>;
};

const envName = (s: string) => s.replace(/[^A-Za-z0-9]/g, "_").toUpperCase();

/** Secrets from the environment: `CRUBAL_SECRET_<OWNER>_<NAME>`. */
export class EnvSecrets implements SecretStore {
  async get(owner: string, name: string): Promise<string | undefined> {
    return process.env[`CRUBAL_SECRET_${envName(owner)}_${envName(name)}`];
  }
}

/** Secrets from a function the host was configured with (a vault client, a file). */
export class FunctionSecrets implements SecretStore {
  private readonly fn: (owner: string, name: string) => string | undefined | Promise<string | undefined>;
  constructor(fn: (owner: string, name: string) => string | undefined | Promise<string | undefined>) {
    this.fn = fn;
  }
  async get(owner: string, name: string): Promise<string | undefined> {
    return this.fn(owner, name);
  }
}

/** Several stores asked in order; the first answer wins. */
export class ChainedSecrets implements SecretStore {
  private readonly stores: SecretStore[];
  constructor(stores: SecretStore[]) {
    this.stores = stores;
  }
  async get(owner: string, name: string): Promise<string | undefined> {
    for (const s of this.stores) {
      const v = await s.get(owner, name);
      if (v !== undefined) return v;
    }
    return undefined;
  }
}
