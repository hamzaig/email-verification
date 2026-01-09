require("dotenv").config();
const emailVerifier = require("../utils/emailVerifier");

// Test emails
const emails = [
  "test@gmail.com",
  "invalid-email",
  "test@mailinator.com",
  "nonexistent@nonexistentdomain123456.com",
  "john.doe@example.com",
  "support@microsoft.com",
  "sales@acme-corp.com",
];

async function runTests() {
  console.log("=== Email Verification Test ===\n");

  for (const email of emails) {
    console.log(`Testing: ${email}`);

    try {
      // Test verification
      console.log("Verification result:");
      const verificationResult = await emailVerifier.verify(email);
      console.log(JSON.stringify(verificationResult, null, 2));

      // Test enrichment for valid emails
      if (verificationResult.formatValid) {
        console.log("\nEnrichment result:");
        const enrichmentResult = await emailVerifier.enrich(email);
        console.log(JSON.stringify(enrichmentResult.enrichment, null, 2));
      }
    } catch (error) {
      console.error(`Error processing ${email}:`, error);
    }

    console.log("\n----------------------------\n");
  }

  console.log("All tests completed!");
}

runTests();
