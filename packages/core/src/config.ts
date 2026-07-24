export interface ActionOptions {
  bodyLimit?: number
}

export interface MinistakConfig {
  serverEntry?: string
  outDir?: string
  actionPath?: string
  actions?: ActionOptions
  spaFallback?: boolean
}

export function defineConfig(config: MinistakConfig): MinistakConfig {
  return config
}
