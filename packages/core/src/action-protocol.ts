export const ACTION_MULTIPART_METADATA_FIELD = '__ministak_action'
export const ACTION_MULTIPART_FILE_PREFIX = '__ministak_file_'

export type ActionFilePath = Array<string | number>

export interface ActionFilePart {
  id: string
  name: string
  type: string
  lastModified: number
}

export interface ActionFileDescriptor {
  kind: 'file' | 'stream' | 'streams'
  path: ActionFilePath
  parts: ActionFilePart[]
}

export interface ActionMultipartMetadata {
  args: unknown[]
  files: ActionFileDescriptor[]
}
