import { registerEnumType } from '@nestjs/graphql';
import { GhanaRegion } from '../../generated/prisma/client';

export { GhanaRegion };

registerEnumType(GhanaRegion, { name: 'GhanaRegion', description: "One of Ghana's 16 administrative regions" });
