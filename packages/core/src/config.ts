export interface MinistakConfig {
  serverEntry?: string
  outDir?: string
  actionPath?: string
}

export function defineConfig(config: MinistakConfig): MinistakConfig {
  return config
}
