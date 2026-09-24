import { describe, expect, it } from 'vitest';
import * as publicApi from '../../src/logics';

const PUBLIC_LOGICS = [
  'bluetooth_disable', 'bluetooth_enable', 'bluetooth_getState', 'bluetooth_search',
  'bridge_destroy', 'bridge_init', 'env_getInfo', 'env_isApp',
  'printer_capture', 'printer_connect', 'printer_disconnect', 'printer_preview', 'printer_print', 'printer_status',
  'scale_connect', 'scale_disconnect', 'scale_readWeight', 'scale_status',
  'scan_cancel', 'scan_start',
] as const;

const ACTION_DATA_SHAPES = {
  bluetooth_getState: ['enabled'], bluetooth_enable: ['enabled', 'pending'], bluetooth_disable: ['enabled', 'pending'], bluetooth_search: ['devices'],
  scale_connect: ['deviceId', 'serviceId'], scale_disconnect: ['alreadyDisconnected', 'deviceId', 'disconnected'], scale_status: ['activeOperation', 'busy', 'connected', 'deviceId', 'deviceName', 'hasStableWeight', 'serviceId'], scale_readWeight: ['overload', 'raw', 'stable', 'unit', 'weight', 'weightType'],
  printer_connect: ['printer'], printer_disconnect: ['alreadyDisconnected', 'deviceId', 'disconnected'], printer_status: ['activeJob', 'busy', 'connected', 'deviceId', 'deviceName'], printer_print: [], printer_preview: ['image'],
  scan_start: ['aimId', 'charset', 'codeId', 'data'], scan_cancel: [],
} as const;

describe('public NASL contract', () => {
  it('exports only the named public logic surface', () => {
    expect(Object.keys(publicApi).sort()).toEqual([...PUBLIC_LOGICS].sort());
  });

  it('keeps the runtime action data-shape fixture complete', () => {
    expect(Object.keys(ACTION_DATA_SHAPES).sort()).toEqual(PUBLIC_LOGICS.filter((name) => !name.startsWith('bridge_') && !name.startsWith('env_') && name !== 'printer_capture').sort());
    expect(ACTION_DATA_SHAPES.bluetooth_search).toEqual(['devices']);
    expect(ACTION_DATA_SHAPES.scale_readWeight).toEqual(['overload', 'raw', 'stable', 'unit', 'weight', 'weightType']);
    expect(ACTION_DATA_SHAPES.printer_preview).toEqual(['image']);
  });
});