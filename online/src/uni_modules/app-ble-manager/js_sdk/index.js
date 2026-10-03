import BleManager from './core/ble-manager';
import createBleApi from './api/ble-api';
import createPrinterApi from './api/printer-api';
import createScaleApi from './api/scale-api';
import createPrinterDomain from './domains/printer';
import createScaleDomain from './domains/scale';

const manager = new BleManager();
const ble = createBleApi(manager);
const printerService = createPrinterDomain({ manager, transport: manager.transport });
const printer = createPrinterApi(printerService);
const scaleService = createScaleDomain({ manager, transport: manager.transport });
const scale = createScaleApi(scaleService);
manager.registerDomainCleaner('printer', async () => {
  await printerService.stopDiscovery();
  await printerService.disconnect();
});
manager.registerDomainCleaner('scale', async () => {
  await scaleService.stopDiscovery();
  await scaleService.disconnect();
});

const lifecycle = Object.freeze({
  shutdown: () => manager.shutdown(),
});
const plugin = Object.freeze({ ble, printer, scale });

export { ble, printer, scale, lifecycle };
export default plugin;