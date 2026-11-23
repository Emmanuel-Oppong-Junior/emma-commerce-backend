import { Module } from '@nestjs/common';
import { CommonsModule } from '../commons/commons.module';
import { OrderModule } from '../order/order.module';
import { PaymentModule } from '../payment/payment.module';
import { DeliveryCodeModule } from './code/delivery-code.module';
import { DeliveryPhotoController } from './proof/delivery-photo.controller';
import {
  ProofOfDeliveryLoader,
  ProofOfDeliveryResolver,
  TrackingStepProofResolver,
} from './proof/proof-of-delivery.resolver';
import { ProofOfDeliveryRepository } from './proof/proof-of-delivery.repository';
import { ProofOfDeliveryService } from './proof/proof-of-delivery.service';
import { MyDeliveriesResolver, RidersResolver, ShipmentRiderLoader } from './riders.resolver';
import { RidersRepository } from './riders.repository';
import { RidersService } from './riders.service';

/** Riders and their deliveries (P5-C.1), proof of delivery (P5-C.2). */
@Module({
  imports: [CommonsModule, OrderModule, PaymentModule, DeliveryCodeModule],
  controllers: [DeliveryPhotoController],
  providers: [
    RidersRepository,
    RidersService,
    RidersResolver,
    MyDeliveriesResolver,
    ShipmentRiderLoader,
    ProofOfDeliveryRepository,
    ProofOfDeliveryService,
    ProofOfDeliveryResolver,
    TrackingStepProofResolver,
    ProofOfDeliveryLoader,
  ],
})
export class DeliveryModule {}
