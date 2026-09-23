import PrinterService from './printer-service';

export default function createPrinterDomain(context) {
  return new PrinterService({
    manager: context.manager,
    transport: context.transport,
    dispatcher: context.manager.dispatcher,
  });
}