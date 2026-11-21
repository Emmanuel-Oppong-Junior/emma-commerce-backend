export enum AuthType {
  Bearer,
  None,
  /** Public, but a bearer token sent with the request is verified and its user attached (an invalid one is refused). */
  Optional,
}
