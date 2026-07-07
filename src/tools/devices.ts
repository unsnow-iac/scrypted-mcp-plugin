import { z } from 'zod';
import { systemManager } from '../scrypted';

export const listDevicesInput = z.object({
    interface: z
        .string()
        .optional()
        .describe(
            'Filter to devices that implement this Scrypted interface (e.g. "OnOff", "VideoCamera", "Brightness").',
        ),
    type: z.string().optional().describe('Filter by ScryptedDeviceType (e.g. "Camera", "Light", "Switch", "Outlet").'),
    name: z.string().optional().describe('Substring match (case-insensitive) on device name.'),
});

export async function listDevices(args: z.infer<typeof listDevicesInput>) {
    const state = systemManager.getSystemState();
    const out: Array<{
        id: string;
        nativeId?: string;
        name: string;
        type: string;
        pluginId?: string;
        room?: string;
        interfaces: string[];
    }> = [];
    const needle = args.name?.toLowerCase();
    for (const id of Object.keys(state)) {
        const dev = state[id];
        const name: string = dev?.name?.value ?? '';
        const type: string = dev?.type?.value ?? '';
        const interfaces: string[] = dev?.interfaces?.value ?? [];
        if (args.interface && !interfaces.includes(args.interface)) continue;
        if (args.type && type !== args.type) continue;
        if (needle && !name.toLowerCase().includes(needle)) continue;
        out.push({
            id,
            nativeId: dev?.nativeId?.value,
            name,
            type,
            pluginId: dev?.pluginId?.value,
            room: dev?.room?.value,
            interfaces,
        });
    }
    out.sort((a, b) => a.name.localeCompare(b.name));
    return { count: out.length, devices: out };
}

export const getDeviceInput = z.object({
    id: z.string().describe('Scrypted device id (the top-level key from list_devices).'),
});

export async function getDevice(args: z.infer<typeof getDeviceInput>) {
    const state = systemManager.getSystemState();
    const dev = state[args.id];
    if (!dev) throw new Error(`device ${args.id} not found`);
    // Snapshot every property's `value`; skip the noisy timestamp fields the SDK attaches.
    const props: Record<string, any> = {};
    for (const [k, v] of Object.entries(dev as Record<string, any>)) props[k] = v?.value;
    return props;
}

export const callDeviceMethodInput = z.object({
    id: z.string().describe('Scrypted device id (the `id` field from list_devices).'),
    method: z.string().describe('Method name on the device (e.g. "turnOn", "setBrightness", "getSettings").'),
    args: z.array(z.any()).optional().describe('Positional arguments to pass to the method. Omit if none.'),
});

export async function callDeviceMethod(args: z.infer<typeof callDeviceMethodInput>) {
    const dev = systemManager.getDeviceById(args.id) as any;
    if (!dev) throw new Error(`device ${args.id} not found`);
    const fn = dev[args.method];
    if (typeof fn !== 'function') throw new Error(`device ${args.id} does not expose method ${args.method}`);
    const result = await fn.apply(dev, args.args ?? []);
    // RPC results may be remote proxies; stringify defensively so we always return JSON-able data.
    try {
        return { result: JSON.parse(JSON.stringify(result ?? null)) };
    } catch {
        return { result: String(result) };
    }
}

// Fork addition (unsnow): read_only tool_profile enforcement. Allow only observation getters
// through call_device_method — reject anything that could mutate a device or its config.
// getSettings (config read) matches the getter pattern; turnOn / setX / putSetting / ptzCommand
// / startIntercom / etc. do not.
const READ_ONLY_METHOD_RE = /^(get|list|is|has|describe|fetch)[A-Z0-9]/;
export async function callDeviceMethodReadOnly(args: z.infer<typeof callDeviceMethodInput>) {
    if (!READ_ONLY_METHOD_RE.test(args.method)) {
        throw new Error(
            `read_only tool_profile: method '${args.method}' is not a read-only getter and is blocked. ` +
                `Set the MCP plugin's tool_profile to 'config' (or 'full') to allow mutating device methods.`,
        );
    }
    return callDeviceMethod(args);
}

// Fork addition (unsnow): one-shot read-only config snapshot across all config-bearing devices.
// Reuses the listDevices iteration + a per-device getSettings(). Secret values are redacted so
// this stays safe in the read_only tool_profile — the raw value is still reachable in the config
// tier via call_device_method('getSettings') on a specific device.
export const exportConfigInput = z.object({
    name: z.string().optional().describe('Optional case-insensitive substring filter on device name.'),
    type: z.string().optional().describe('Optional ScryptedDeviceType filter (e.g. "Camera", "Light").'),
});

const SECRET_KEY_RE = /(password|secret|token|api[_-]?key)/i;
function redactSettings(settings: unknown): unknown {
    if (!Array.isArray(settings)) return settings;
    return settings.map((s: any) => {
        if (!s || typeof s !== 'object') return s;
        const isSecret =
            s.type === 'password' || SECRET_KEY_RE.test(String(s.key ?? '')) || SECRET_KEY_RE.test(String(s.title ?? ''));
        return isSecret && s.value !== undefined && s.value !== null && s.value !== ''
            ? { ...s, value: '***redacted***' }
            : s;
    });
}

export async function exportConfig(args: z.infer<typeof exportConfigInput>) {
    const state = systemManager.getSystemState();
    const needle = args.name?.toLowerCase();
    const out: Array<{ id: string; name: string; type: string; settings?: unknown; error?: string }> = [];
    for (const id of Object.keys(state)) {
        const dev = state[id];
        const name: string = dev?.name?.value ?? '';
        const type: string = dev?.type?.value ?? '';
        const interfaces: string[] = dev?.interfaces?.value ?? [];
        if (!interfaces.includes('Settings')) continue; // only config-bearing devices
        if (args.type && type !== args.type) continue;
        if (needle && !name.toLowerCase().includes(needle)) continue;
        try {
            const d = systemManager.getDeviceById(id) as any;
            const settings = await d.getSettings();
            // RPC results may be remote proxies; stringify defensively before redaction.
            const plain = JSON.parse(JSON.stringify(settings ?? []));
            out.push({ id, name, type, settings: redactSettings(plain) });
        } catch (e: any) {
            out.push({ id, name, type, error: e?.message ?? String(e) });
        }
    }
    out.sort((a, b) => a.name.localeCompare(b.name));
    return { count: out.length, devices: out };
}
