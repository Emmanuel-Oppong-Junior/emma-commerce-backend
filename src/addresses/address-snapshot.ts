import { Address } from '../generated/prisma/client';

/** The delivery address as copied onto an order, so later edits to the saved address do not change the order. */
export function toAddressSnapshot(address: Address): Record<string, unknown> {
  return {
    recipientName: address.recipientName,
    phone: address.phone,
    region: address.region,
    street: address.street,
    city: address.city,
    area: address.area,
    landmark: address.landmark,
    ghanaPostGps: address.ghanaPostGps,
    latitude: address.latitude?.toNumber() ?? null,
    longitude: address.longitude?.toNumber() ?? null,
    zipCode: address.zipCode,
    country: address.country,
  };
}
