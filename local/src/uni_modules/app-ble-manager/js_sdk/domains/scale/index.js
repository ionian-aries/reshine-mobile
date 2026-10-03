import ScaleProfile from './scale-profile';
import ScaleService from './scale-service';

export default function createScaleDomain(context, options) {
  const profile = (options && options.profile) || new ScaleProfile(options && options.profileOptions);
  return new ScaleService({
    transport: context.transport,
    dispatcher: context.manager.dispatcher,
    profile,
  });
}