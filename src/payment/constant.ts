export const PAYSTACK_TRANSACTION_INI_URL = 'https://api.paystack.co/transaction/initialize';

export const PAYSTACK_TRANSACTION_LIST_URL = 'https://api.paystack.co/transaction';

export const PAYSTACK_TRANSACTION_VERIFY_BASE_URL = 'https://api.paystack.co/transaction/verify';

export const PAYSTACK_WEBHOOK_CRYPTO_ALGO = 'sha512';
export const PAYSTACK_WEBHOOK_SIGNATURE_KEY = 'x-paystack-signature';
export const PAYSTACK_SUCCESS_STATUS = 'success';

/** Order totals are GHS amounts, so the charge currency is fixed server-side. */
export const CHARGE_CURRENCY = 'GHS';
