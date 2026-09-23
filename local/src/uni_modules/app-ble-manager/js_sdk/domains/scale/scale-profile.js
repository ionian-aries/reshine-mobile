import { ErrorCodes } from '../../errors/codes';
import { createBleError } from '../../errors/normalize';

const MAX_BUFFER_LENGTH = 512;
const VERIFIED_SERVICE_UUID = '49535343-FE7D-4AE5-8FA9-9FAFD205E455';
const VERIFIED_WEIGHT_CHARACTERISTIC_UUID = '49535343-1E4D-4BD9-BA61-23C647249616';
const VERIFIED_WRITE_CHARACTERISTIC_UUID = '49535343-8841-43F4-A8D4-ECBE34729BB3';
const SCALE_ADVERTISEMENT_SERVICE_UUID = '000018F0-0000-1000-8000-00805F9B34FB';
const VERIFIED_WEIGHT_TYPES = Object.freeze({
  NT: 'net',
  TR: 'tare',
});
const SUPPORTED_UNITS = Object.freeze(['kg', 'g', 'lb', 'oz']);

function normalizeUuid(value) {
  const normalized = String(value || '').trim().toUpperCase();
  if (/^[0-9A-F]{4}$/.test(normalized)) {
    return `0000${normalized}-0000-1000-8000-00805F9B34FB`;
  }
  if (/^[0-9A-F]{8}$/.test(normalized)) {
    return `${normalized}-0000-1000-8000-00805F9B34FB`;
  }
  return normalized;
}

function bytesToAscii(buffer) {
  return Array.from(new Uint8Array(buffer || new ArrayBuffer(0)))
    .map((value) => String.fromCharCode(value))
    .join('');
}

function parseNumber(text) {
  const compact = String(text || '').replace(/\s/g, '');
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(compact)) {
    throw createBleError(ErrorCodes.SCALE_WEIGHT_INVALID, '电子秤数值格式无效');
  }
  const value = Number(compact);
  if (!Number.isFinite(value)) throw createBleError(ErrorCodes.SCALE_WEIGHT_INVALID, '电子秤数值无效');
  return value;
}

function normalizeUnit(value) {
  const unit = String(value || '').trim().toLowerCase();
  if (!SUPPORTED_UNITS.includes(unit)) {
    throw createBleError(ErrorCodes.SCALE_FRAME_INVALID, `电子秤单位无效：${unit || '空'}`);
  }
  return unit;
}

function stripTransportPrefix(frame) {
  const text = String(frame || '').replace(/[\r\n]+$/, '');
  const headerIndex = text.search(/(?:ST|US|OL),(?:NT|TR),/i);
  return (headerIndex >= 0 ? text.slice(headerIndex) : text).trim();
}

function createReading(fields) {
  const value = fields.overloaded ? null : Number(fields.value);
  const receivedAt = Date.now();
  return Object.freeze({
    raw: Number.isFinite(value) ? value : null,
    rawWeight: fields.rawWeight,
    value: Number.isFinite(value) ? value : null,
    unit: normalizeUnit(fields.unit),
    stable: !fields.overloaded && !!fields.stable,
    overloaded: !!fields.overloaded,
    negative: Number.isFinite(value) && value < 0,
    sign: fields.sign || (Number.isFinite(value) && value < 0 ? '-' : '+'),
    valid: !fields.overloaded && Number.isFinite(value),
    weightType: fields.weightType || 'NT',
    weightTypeMeaning: VERIFIED_WEIGHT_TYPES[fields.weightType || 'NT'],
    status: fields.overloaded ? 'overload' : (fields.stable ? 'stable' : 'unstable'),
    rawFrame: fields.rawFrame,
    receivedAt,
    timestamp: receivedAt,
  });
}

function parseAsciiFrame(frame) {
  const raw = stripTransportPrefix(frame);
  const overload = /^OL,(NT|TR),([+-])\s*(kg|lb|g|oz)$/i.exec(raw);
  if (overload) {
    return createReading({
      overloaded: true,
      stable: false,
      value: null,
      rawWeight: '',
      unit: overload[3],
      sign: overload[2],
      weightType: overload[1].toUpperCase(),
      rawFrame: raw,
    });
  }
  const match = /^(ST|US),(NT|TR),([+-])\s*(\d+(?:\.\d*)?|\.\d+)\s*(kg|lb|g|oz)$/i.exec(raw);
  if (match) {
    const status = match[1].toUpperCase();
    const rawWeight = match[4];
    return createReading({
      stable: status === 'ST',
      value: parseNumber(match[3] + rawWeight),
      rawWeight,
      unit: match[5],
      sign: match[3],
      weightType: match[2].toUpperCase(),
      rawFrame: raw,
    });
  }
  throw createBleError(ErrorCodes.SCALE_FRAME_INVALID, `无法识别电子秤数据帧：${raw.slice(0, 80)}`);
}

export default class ScaleProfile {
  constructor(options) {
    this.options = options || {};
    this.id = 'ascii-weight-v1';
    this.serviceUuid = normalizeUuid(this.options.serviceUuid || VERIFIED_SERVICE_UUID);
    this.weightCharacteristicUuid = normalizeUuid(this.options.weightCharacteristicUuid || VERIFIED_WEIGHT_CHARACTERISTIC_UUID);
    this.writeCharacteristicUuid = normalizeUuid(this.options.writeCharacteristicUuid || VERIFIED_WRITE_CHARACTERISTIC_UUID);
  }

  matches(device) {
    const advertisedServices = (device && device.advertisServiceUUIDs) || [];
    const advertisementService = normalizeUuid(SCALE_ADVERTISEMENT_SERVICE_UUID);
    return advertisedServices.some((uuid) => normalizeUuid(uuid) === advertisementService);
  }

  identityReasons(device) {
    return this.matches(device)
      ? [`广播包含电子秤候选服务 UUID ${SCALE_ADVERTISEMENT_SERVICE_UUID}`]
      : [];
  }

  selectGatt(services, characteristicsByService) {
    const preferredService = normalizeUuid(this.serviceUuid);
    const preferredCharacteristic = normalizeUuid(this.weightCharacteristicUuid);
    const preferredWriteCharacteristic = normalizeUuid(this.writeCharacteristicUuid);
    const service = services.find((item) => normalizeUuid(item.uuid) === preferredService);
    if (!service) return null;
    const list = characteristicsByService[service.uuid] || [];
    const notify = list.find((item) => (
      normalizeUuid(item.uuid) === preferredCharacteristic &&
      item.properties && item.properties.notify
    ));
    const write = list.find((item) => (
      normalizeUuid(item.uuid) === preferredWriteCharacteristic &&
      item.properties && (item.properties.write || item.properties.writeNoResponse)
    ));
    return notify && write ? {
      serviceId: service.uuid,
      notifyCharacteristic: notify,
      writeCharacteristic: write,
    } : null;
  }

  createDecoder() {
    let buffer = '';
    let synced = false;
    return {
      push(data) {
        buffer += bytesToAscii(data);
        const readings = [];
        let delimiter;
        while ((delimiter = buffer.indexOf('\r\n')) >= 0) {
          const frame = buffer.slice(0, delimiter);
          buffer = buffer.slice(delimiter + 2);
          if (!frame.trim()) continue;
          try {
            readings.push(parseAsciiFrame(frame));
            synced = true;
          } catch (error) {
            // 该秤持续推送 CRLF 分隔帧；订阅建立时可能从一帧中部开始接收。
            // 首个残片没有 ST/US/OL 状态前缀时丢弃，等待下一条完整帧。
            if (synced || !/^,(?:NT|GS|TR),/i.test(frame.trim())) throw error;
          }
        }
        if (buffer.length > MAX_BUFFER_LENGTH) {
          buffer = buffer.slice(-64);
          synced = false;
        }
        return readings;
      },
      reset() { buffer = ''; synced = false; },
    };
  }
}