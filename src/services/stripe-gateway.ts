import Stripe from "stripe";

export interface StripeGateway {
  createCheckoutSession(
    params: Stripe.Checkout.SessionCreateParams,
    idempotencyKey: string,
  ): Promise<Stripe.Checkout.Session>;
  retrieveCheckoutSession(id: string): Promise<Stripe.Checkout.Session>;
  retrievePaymentIntent(id: string): Promise<Stripe.PaymentIntent>;
  retrieveCharge(id: string): Promise<Stripe.Charge>;
  constructWebhookEvent(
    body: Buffer,
    signature: string,
    secret: string,
  ): Stripe.Event;
}

export class StripeSdkGateway implements StripeGateway {
  private readonly stripe: Stripe;

  constructor(secretKey: string, apiVersion: "2026-09-30.endive") {
    this.stripe = new Stripe(secretKey, {
      apiVersion,
      maxNetworkRetries: 2,
      timeout: 20_000,
    });
  }

  createCheckoutSession(
    params: Stripe.Checkout.SessionCreateParams,
    idempotencyKey: string,
  ) {
    return this.stripe.checkout.sessions.create(params, { idempotencyKey });
  }

  retrieveCheckoutSession(id: string) {
    return this.stripe.checkout.sessions.retrieve(id, {
      expand: ["payment_intent.latest_charge.balance_transaction"],
    });
  }

  retrievePaymentIntent(id: string) {
    return this.stripe.paymentIntents.retrieve(id, {
      expand: ["latest_charge.balance_transaction"],
    });
  }

  retrieveCharge(id: string) {
    return this.stripe.charges.retrieve(id, {
      expand: ["payment_intent", "balance_transaction", "refunds.data"],
    });
  }

  constructWebhookEvent(body: Buffer, signature: string, secret: string) {
    return this.stripe.webhooks.constructEvent(body, signature, secret);
  }
}
