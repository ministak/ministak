export const DEV_ROUTE_MISS_HEADER = 'x-ministak-route-miss'

export type PageAppType = 'spa' | 'mpa'

export function resolvePageAppType(value: string): PageAppType {
  if (value === 'spa' || value === 'mpa') {
    return value
  }
  throw new Error('Vite appType 仅支持 "spa" 和 "mpa"')
}

export function isSpaFallbackRequest(
  method: string | undefined,
  accept: string | undefined,
  pathname: string,
  basePath: string,
): boolean {
  const insideBase =
    basePath === '/' ||
    pathname === basePath.slice(0, -1) ||
    pathname.startsWith(basePath)
  return method === 'GET' && accept?.includes('text/html') === true && insideBase
}
