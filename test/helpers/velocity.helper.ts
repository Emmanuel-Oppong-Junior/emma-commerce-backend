/** A VelocityService stand-in for unit tests: every check passes with no hits and nothing is counted. */
export function velocityStub() {
  return {
    screenOrRefuse: jest.fn().mockResolvedValue([]),
    screen: jest.fn().mockResolvedValue([]),
    record: jest.fn().mockResolvedValue(undefined),
    flagOrder: jest.fn().mockResolvedValue(undefined),
  };
}

/** A CodRiskService stand-in for unit tests: cash on delivery is available and every gate passes. */
export function codRiskStub() {
  return {
    availability: jest.fn().mockResolvedValue({ available: true, reason: null, phoneVerified: true }),
    assertCodAllowed: jest.fn().mockResolvedValue('+233244000000'),
  };
}
