import { Address, GhanaRegion } from '../generated/prisma/client';

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

/** A delivery address typed in at checkout instead of saved (a guest's, P6-G.1), validated like CreateAddressInput. */
export interface EnteredAddress {
  recipientName: string;
  phone: string;
  region: GhanaRegion;
  street: string;
  city: string;
  area?: string | null;
  landmark?: string | null;
  ghanaPostGps?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  zipCode?: string | null;
  country: string;
}

/** The same snapshot as toAddressSnapshot, for an address entered at checkout. */
export function toEnteredAddressSnapshot(address: EnteredAddress): Record<string, unknown> {
  return {
    recipientName: address.recipientName,
    phone: address.phone,
    region: address.region,
    street: address.street,
    city: address.city,
    area: address.area ?? null,
    landmark: address.landmark ?? null,
    ghanaPostGps: address.ghanaPostGps ?? null,
    latitude: address.latitude ?? null,
    longitude: address.longitude ?? null,
    zipCode: address.zipCode ?? null,
    country: address.country,
  };
}
