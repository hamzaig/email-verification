const emailVerifier = require("../utils/emailVerifier");
const net = require("net");

// Mock the DNS module
jest.mock("dns", () => ({
  resolveMx: jest.fn((domain, callback) => {
    if (domain === "gmail.com") {
      callback(null, [
        { exchange: "gmail-smtp-in.l.google.com", priority: 10 },
      ]);
    } else if (domain === "example.com") {
      callback(null, [{ exchange: "mail.example.com", priority: 10 }]);
    } else if (domain === "acme-inc.com") {
      callback(null, [{ exchange: "mail.acme-inc.com", priority: 10 }]);
    } else if (domain === "invalid-domain.com") {
      callback(null, []);
    } else {
      callback(new Error("DNS query failed"), null);
    }
  }),
}));

// Mock the net module for SMTP checks
jest.mock("net", () => {
  const mockSocket = {
    setTimeout: jest.fn(),
    on: jest.fn((event, callback) => {
      if (event === "connect" && mockSocket.shouldConnect) {
        callback();
      } else if (event === "error" && !mockSocket.shouldConnect) {
        callback(new Error("Connection failed"));
      }
      return mockSocket;
    }),
    connect: jest.fn(),
    destroy: jest.fn(),
  };

  return {
    Socket: jest.fn(() => {
      // Reset the mock for each new instance
      mockSocket.shouldConnect = true;
      return mockSocket;
    }),
    _getMockSocket: () => mockSocket, // Helper for tests
  };
});

describe("Email Verifier", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Set the socket to connect successfully
    const mockSocket = net._getMockSocket();
    mockSocket.shouldConnect = true;
  });

  test("should validate a correct email format", async () => {
    const result = await emailVerifier.verify("test@gmail.com");
    expect(result.formatValid).toBe(true);
  });

  test("should invalidate incorrect email format", async () => {
    const result = await emailVerifier.verify("not-an-email");
    expect(result.formatValid).toBe(false);
    expect(result.isValid).toBe(false);
  });

  test("should detect disposable email domains", async () => {
    const result = await emailVerifier.verify("test@mailinator.com");
    expect(result.isDisposable).toBe(true);
    expect(result.isValid).toBe(false);
  });

  test("should verify MX records for valid domains", async () => {
    const result = await emailVerifier.verify("test@gmail.com");
    expect(result.hasMx).toBe(true);
  });

  test("should handle domains without MX records", async () => {
    const result = await emailVerifier.verify("test@invalid-domain.com");
    expect(result.hasMx).toBe(false);
    expect(result.isValid).toBe(false);
  });

  test("should provide name extraction from email", async () => {
    const result = await emailVerifier.enrich("john.doe@example.com");
    expect(result.enrichment).toBeDefined();
    expect(result.enrichment.possibleName.first).toBe("john");
    expect(result.enrichment.possibleName.last).toBe("doe");
  });

  test("should identify free email providers", async () => {
    const result = await emailVerifier.enrich("test@gmail.com");
    expect(result.enrichment.isFreeProvider).toBe(true);
  });

  test("should attempt to guess company name from domain", async () => {
    const result = await emailVerifier.enrich("contact@acme-inc.com");
    expect(result.enrichment).toBeDefined();
    expect(result.enrichment.possibleCompany).toBe("Acme Inc");
  });
});
