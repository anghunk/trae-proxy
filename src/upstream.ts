export type TraeUpstreamErrorKind =
  | 'authentication'
  | 'hard_credit'
  | 'soft_rate'
  | 'not_found'
  | 'server'
  | 'client'
  | 'unconfigured'

export type TraeChatResult =
  | { ok: true; response: Response }
  | { ok: false; status: number; kind: TraeUpstreamErrorKind; message: string }

export interface TraeUpstreamClient {
  chatStream(bodyJson: string, signal?: AbortSignal): Promise<TraeChatResult>
}
