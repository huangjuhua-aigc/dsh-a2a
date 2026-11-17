export interface ConnectionInfo { connectionId: string; provider: 'google' | 'feishu'; label: string; coverage: string }
export function connectionInfo(file: string): Promise<ConnectionInfo | undefined>
export function saveConnection(file: string, connection: Record<string, unknown>, check?: () => void): Promise<ConnectionInfo>
export function disconnect(file: string): Promise<void>
export interface GoogleClient { clientId: string; clientSecret?: string }
export function readGoogleClient(file: string): Promise<GoogleClient | undefined>
export function importGoogleClient(file: string, document: unknown): Promise<{ saved: true }>
export function forgetGoogleClient(file: string): Promise<void>
export function executeTool(file: string, expectedId: string, visitor: string, name: string, args: unknown, io?: { signal?: AbortSignal; fetch?: typeof fetch; now?: () => number }): Promise<Record<string, unknown>>
