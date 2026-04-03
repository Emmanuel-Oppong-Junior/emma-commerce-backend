declare module 'paystack-api' {
  namespace Paystack {
    interface Response<T> {
      status: boolean;
      message: string;
      data: T;
    }

    namespace Transaction {
      interface InitializeResponse {
        authorization_url: string;
        access_code: string;
        reference: string;
      }

      interface VerifyResponse {
        reference: string;
        status: string;
        amount: number;
        currency: string;
        channel: string;
        paid_at: string;
        gateway_response: string;
      }
    }

    interface TransactionResource {
      initialize(params: {
        email: string;
        amount: number;
        currency?: string;
        reference?: string;
        callback_url?: string;
        [key: string]: unknown;
      }): Promise<Response<Transaction.InitializeResponse>>;

      verify(params: { reference: string }): Promise<Response<Transaction.VerifyResponse>>;
    }

    interface Client {
      transaction: TransactionResource;
    }
  }

  function Paystack(secretKey: string | undefined): Paystack.Client;

  export = Paystack;
}
