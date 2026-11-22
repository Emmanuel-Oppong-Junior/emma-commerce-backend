/** A VelocityService stand-in for unit tests: every check passes with no hits and nothing is counted. */
export function velocityStub() {
  return {
    screenOrRefuse: jest.fn().mockResolvedValue([]),
    screen: jest.fn().mockResolvedValue([]),
    record: jest.fn().mockResolvedValue(undefined),
    flagOrder: jest.fn().mockResolvedValue(undefined),
  };
}
