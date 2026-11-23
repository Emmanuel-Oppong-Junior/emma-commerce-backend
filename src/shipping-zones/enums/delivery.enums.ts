import { registerEnumType } from '@nestjs/graphql';
import { DeliveryServiceLevel, Weekday, ZoneAreaLevel } from '../../generated/prisma/client';

export { DeliveryServiceLevel, Weekday, ZoneAreaLevel };

registerEnumType(Weekday, { name: 'Weekday' });

registerEnumType(DeliveryServiceLevel, {
  name: 'DeliveryServiceLevel',
  description: 'How fast an order is delivered; each zone prices the levels it offers',
});
registerEnumType(ZoneAreaLevel, {
  name: 'ZoneAreaLevel',
  description: 'How specific a zone area is: an address matches its most specific entry (AREA > TOWN > REGION)',
});
