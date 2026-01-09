const request = require("supertest");
const app = require("../server");
const mongoose = require("mongoose");
const User = require("../models/User");
const jwt = require("jsonwebtoken");
const Usage = require("../models/Usage");

// Mock the emailVerifier utility
jest.mock("../utils/emailVerifier", () => ({
  verify: jest.fn().mockResolvedValue({
    email: "test@example.com",
    isValid: true,
    formatValid: true,
    hasMx: true,
    isDisposable: false,
    smtpCheck: true,
    suggestion: null,
    domain: "example.com",
    errors: [],
  }),
  enrich: jest.fn().mockResolvedValue({
    email: "test@example.com",
    isValid: true,
    formatValid: true,
    hasMx: true,
    isDisposable: false,
    smtpCheck: true,
    suggestion: null,
    domain: "example.com",
    errors: [],
    enrichment: {
      possibleName: { full: "Test User", first: "Test", last: "User" },
      possibleCompany: "Example",
      isFreeProvider: false,
      domainCategory: "standard",
    },
  }),
}));

describe("API Routes", () => {
  let token;
  let testUser;
  let server;

  beforeAll(async () => {
    // Connect to test database
    await mongoose.connect(
      process.env.MONGO_URI ||
        "mongodb://localhost:27017/email-verification-api-test",
      {
        useNewUrlParser: true,
        useUnifiedTopology: true,
      }
    );

    // Create a test user
    testUser = new User({
      name: "Test User",
      email: "test@example.com",
      password: "password123",
      role: "business",
      apiKey: "test_api_key_12345",
    });

    await testUser.save();

    // Generate auth token
    token = jwt.sign(
      { user: { id: testUser._id } },
      process.env.JWT_SECRET || "testsecret",
      { expiresIn: "1h" }
    );

    // Start server on a different port for tests
    server = app.listen(3001);
  }, 10000);

  afterAll(async () => {
    // Clean up
    await User.deleteMany({});
    await Usage.deleteMany({});
    await mongoose.connection.close();
    await new Promise((resolve) => server.close(resolve));
  }, 10000);

  test("should verify an email with valid token", async () => {
    const res = await request(app)
      .post("/api/verify")
      .set("x-auth-token", token)
      .send({ email: "test@example.com" });

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.isValid).toBe(true);
  }, 10000);

  test("should reject verification without auth token", async () => {
    const res = await request(app)
      .post("/api/verify")
      .send({ email: "test@example.com" });

    expect(res.statusCode).toBe(401);
  }, 10000);

  test("should allow verification with API key", async () => {
    const res = await request(app)
      .post("/api/verify")
      .set("x-api-key", "test_api_key_12345")
      .send({ email: "test@example.com" });

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
  }, 10000);

  test("should provide email enrichment for business tier", async () => {
    const res = await request(app)
      .post("/api/enrich")
      .set("x-auth-token", token)
      .send({ email: "test@example.com" });

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.enrichment).toBeDefined();
  }, 10000);

  test("should handle bulk verification requests", async () => {
    const res = await request(app)
      .post("/api/bulk-verify")
      .set("x-auth-token", token)
      .send({ emails: ["test1@example.com", "test2@example.com"] });

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data.length).toBe(2);
  }, 10000);

  test("should provide usage statistics", async () => {
    const res = await request(app).get("/api/usage").set("x-auth-token", token);

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.plan).toBe("business");
  }, 10000);
});
