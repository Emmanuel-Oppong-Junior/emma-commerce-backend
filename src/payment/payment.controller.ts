import { Body, Controller, HttpCode, HttpStatus, Ip, Post, RawBodyRequest, Req } from '@nestjs/common';
import { Request } from 'express';
import { Throttle } from '@nestjs/throttler';
import { PaymentService } from './payment.service';
import { PaymentWebhookService } from './payment-webhook.service';
import { CreatePaymentDto } from './dto/create-payment.dto';
import { ActiveUser } from '../iam/authentication/decorators/active-user.decorator';
import { Auth } from '../iam/authentication/decorators/auth.decorator';
import { AuthType } from '../iam/authentication/enums/auth-type.enum';

@Controller('payment')
export class PaymentController {
  constructor(
    private readonly paymentService: PaymentService,
    private readonly paymentWebhookService: PaymentWebhookService,
  ) {}

  @Auth(AuthType.Bearer)
  @Throttle({ payment: { limit: 5, ttl: 60000 } })
  @Post('/initialize')
  async initializeTransaction(
    @Body() createPaymentDto: CreatePaymentDto,
    @ActiveUser('id') userId: string,
    @Ip() clientIp: string,
  ) {
    return this.paymentService.initiatePayment(userId, createPaymentDto, clientIp);
  }

  @Auth(AuthType.None)
  @Post('/webhook')
  @HttpCode(HttpStatus.OK)
  async paymentWebhookHandler(@Req() request: RawBodyRequest<Request>): Promise<void> {
    await this.paymentWebhookService.handlePaystackWebhook(request.rawBody, request.headers);
  }
}
