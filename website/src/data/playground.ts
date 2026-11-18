export type Execution = 'http' | 'browser';
export type RouteClass = 'direct' | 'datacenter' | 'residential';
export type ExecutionCapability = { id: Execution; available: boolean; reason?: string | null; methods?: string[]; headers?: string[]; max_wait_ms?: number };
type RouteAvailability = { available: boolean; reason?: string | null; countries: string[] };
export type RouteCapability = RouteAvailability & { class: RouteClass; executions?: Partial<Record<Execution, RouteAvailability>> };
export type PlaygroundCapabilities = { executions: ExecutionCapability[]; routes: RouteCapability[] };
export type SafeKey = { id: string; name: string; scopes: string[]; revoked_at?: string | null };
export type Preparation = {
  ready: boolean; execution: Execution; url: string | null; access_profile: { id: string; version: number } | null;
  selected_key_id: string | null; keys: SafeKey[]; capabilities: PlaygroundCapabilities;
  quote: { credits: number; max_estimated_micro_usd: number | null } | null;
  errors: { field: string; code: string; message: string }[];
};
export const routeClasses = ['direct', 'datacenter', 'residential'] as const;
export const routeLabels = { direct: 'Direct', datacenter: 'Datacenter', residential: 'Residential' };
export const operationResource = (mode: Execution) => mode === 'browser' ? '/render' : '/fetch';
export const operationExecution = (key: string): Execution => key.startsWith('render_') ? 'browser' : 'http';

export function requestCode(base: string, execution: Execution, language: string, body: Record<string, unknown> | null, recoverKey: string) {
  const endpoint = base + '/v2' + operationResource(execution) + (recoverKey ? '/' + encodeURIComponent(recoverKey) : '');
  const recovering = Boolean(recoverKey);
  const payload = { ...body };
  delete payload.idempotency_key;
  delete payload.key_id;
  if (language === 'javascript') {
    const setup = recovering ? '' : `const operationKey = globalThis.crypto.randomUUID();\nconsole.error("Operation key:", operationKey);\n`;
    const data = recovering ? '' : `,\n  body: JSON.stringify({ ...${JSON.stringify(payload, null, 2)}, idempotency_key: operationKey })`;
    return `${setup}const response = await fetch(${JSON.stringify(endpoint)}, {\n  method: "${recovering ? 'GET' : 'POST'}",\n  headers: { Authorization: \`Bearer \${process.env.FETCHX_API_KEY}\`${recovering ? '' : ', "Content-Type": "application/json"'} }${data}\n});\nconsole.log(await response.json());`;
  }
  if (language === 'python') {
    const setup = recovering ? 'import os, requests\n' : `import json, os, sys, uuid, requests\noperation_key = str(uuid.uuid4())\nprint("Operation key:", operation_key, file=sys.stderr)\npayload = json.loads(${JSON.stringify(JSON.stringify(payload))})\npayload["idempotency_key"] = operation_key\n`;
    return `${setup}response = requests.${recovering ? 'get' : 'post'}(\n    ${JSON.stringify(endpoint)},\n    headers={"Authorization": "Bearer " + os.environ["FETCHX_API_KEY"]}${recovering ? '' : ',\n    json=payload'}\n)\nprint(response.json())`;
  }
  const shell = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
  const setup = recovering ? '' : 'operation_key="$(uuidgen)" || exit 1\nprintf \'Operation key: %s\\n\' "$operation_key" >&2\n';
  const data = recovering ? '' : ' \\\n  -H "Content-Type: application/json" \\\n  --data-binary \'{"idempotency_key":"\'"$operation_key"' + shell('",' + JSON.stringify(payload).slice(1));
  return `${setup}curl ${shell(endpoint)} \\\n  -H "Authorization: Bearer $FETCHX_API_KEY"${data}`;
}
