// utils/emailVerifier.js - Core email verification functionality

const dns = require("dns");
const { promisify } = require("util");
const validator = require("validator");
const net = require("net");

// Promisify DNS resolver
const resolveMx = promisify(dns.resolveMx);

// Disposable email domains list (abbreviated - would be more extensive in production)
const disposableDomains = [
  "mailinator.com",
  "tempmail.com",
  "guerrillamail.com",
  "temp-mail.org",
  "fakeinbox.com",
  "10minutemail.com",
  "yopmail.com",
  "throwawaymail.com",
];

// Email verification class
class EmailVerifier {
  /**
   * Perform comprehensive email verification
   * @param {string} email - The email to verify
   * @returns {Object} - Verification results
   */
  async verify(email) {
    try {
      // Start with basic format validation
      const result = {
        email,
        timestamp: new Date(),
        isValid: false,
        formatValid: false,
        hasMx: false,
        isDisposable: false,
        smtpCheck: false,
        suggestion: null,
        domain: null,
        errors: [],
      };

      // Extract domain
      const parts = email.split("@");
      if (parts.length !== 2) {
        result.errors.push("Invalid email format");
        return result;
      }

      result.domain = parts[1].toLowerCase();

      // Format validation
      if (validator.isEmail(email)) {
        result.formatValid = true;
      } else {
        result.errors.push("Invalid email format");
        return result;
      }

      // Check if domain is disposable
      if (disposableDomains.includes(result.domain)) {
        result.isDisposable = true;
      }

      // Check MX records
      try {
        const mxRecords = await resolveMx(result.domain);
        result.hasMx = mxRecords && mxRecords.length > 0;
        if (!result.hasMx) {
          result.errors.push("No MX records found for domain");
        }
      } catch (error) {
        result.errors.push("MX lookup failed");
        result.hasMx = false;
      }

      // Perform basic SMTP validation (connection test only)
      // In a production environment, you'd implement a more comprehensive SMTP check
      if (result.hasMx) {
        result.smtpCheck = await this.basicSmtpCheck(result.domain);
      }

      // Suggest corrections for common typos
      result.suggestion = this.suggestCorrection(email);

      // Final validity determination
      result.isValid =
        result.formatValid && result.hasMx && !result.isDisposable;

      return result;
    } catch (error) {
      console.error("Email verification error:", error);
      return {
        email,
        isValid: false,
        errors: ["Verification process failed"],
      };
    }
  }

  /**
   * Basic check if SMTP server exists and responds
   * @param {string} domain - The domain to check
   * @returns {boolean} - Whether SMTP server responds
   */
  async basicSmtpCheck(domain) {
    return new Promise((resolve) => {
      try {
        const socket = new net.Socket();
        let resolved = false;

        // Set timeout to 3 seconds
        socket.setTimeout(3000);

        socket.on("timeout", () => {
          if (!resolved) {
            resolved = true;
            socket.destroy();
            resolve(false);
          }
        });

        socket.on("error", () => {
          if (!resolved) {
            resolved = true;
            resolve(false);
          }
        });

        socket.on("connect", () => {
          if (!resolved) {
            resolved = true;
            socket.destroy();
            resolve(true);
          }
        });

        // Try connecting to port 25
        socket.connect(25, domain);
      } catch (error) {
        resolve(false);
      }
    });
  }

  /**
   * Suggest corrections for common email typos
   * @param {string} email - The email to check
   * @returns {string|null} - Suggested correction or null
   */
  suggestCorrection(email) {
    const commonDomains = [
      "gmail.com",
      "yahoo.com",
      "hotmail.com",
      "outlook.com",
      "aol.com",
      "icloud.com",
      "protonmail.com",
    ];

    const parts = email.split("@");
    if (parts.length !== 2) return null;

    const [username, domain] = parts;

    // Check for common typos in popular domains
    const corrections = {
      "gmal.com": "gmail.com",
      "gamil.com": "gmail.com",
      "gmial.com": "gmail.com",
      "gmail.co": "gmail.com",
      "gmaill.com": "gmail.com",
      "yahooo.com": "yahoo.com",
      "yaho.com": "yahoo.com",
      "yahoo.co": "yahoo.com",
      "hotmial.com": "hotmail.com",
      "hotmal.com": "hotmail.com",
      "hotmai.com": "hotmail.com",
      "outlok.com": "outlook.com",
      "outook.com": "outlook.com",
    };

    if (corrections[domain]) {
      return `${username}@${corrections[domain]}`;
    }

    // Find closest match if there's a slight typo
    for (const correctDomain of commonDomains) {
      // Simple character difference check (very basic)
      if (this.levenshteinDistance(domain, correctDomain) === 1) {
        return `${username}@${correctDomain}`;
      }
    }

    return null;
  }

  /**
   * Calculate Levenshtein distance between two strings
   * @param {string} a - First string
   * @param {string} b - Second string
   * @returns {number} - The edit distance
   */
  levenshteinDistance(a, b) {
    if (a.length === 0) return b.length;
    if (b.length === 0) return a.length;

    const matrix = Array(a.length + 1)
      .fill()
      .map(() => Array(b.length + 1).fill(0));

    for (let i = 0; i <= a.length; i++) {
      matrix[i][0] = i;
    }

    for (let j = 0; j <= b.length; j++) {
      matrix[0][j] = j;
    }

    for (let i = 1; i <= a.length; i++) {
      for (let j = 1; j <= b.length; j++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        matrix[i][j] = Math.min(
          matrix[i - 1][j] + 1, // deletion
          matrix[i][j - 1] + 1, // insertion
          matrix[i - 1][j - 1] + cost // substitution
        );
      }
    }

    return matrix[a.length][b.length];
  }

  /**
   * Enrich email with additional information
   * @param {string} email - The email to enrich
   * @returns {Object} - Enrichment data
   */
  async enrich(email) {
    try {
      const verificationResult = await this.verify(email);
      if (!verificationResult.isValid) {
        return {
          ...verificationResult,
          enrichment: null,
        };
      }

      const parts = email.split("@");
      const domain = parts[1].toLowerCase();

      // Basic enrichment (would be expanded in production)
      const enrichment = {
        domain,
        // Extract possible name from email
        possibleName: this.extractNameFromEmail(parts[0]),
        // Company/organization guess based on domain
        possibleCompany: this.guessCompanyFromDomain(domain),
        // Is free email provider?
        isFreeProvider: this.isFreeEmailProvider(domain),
        // Domain age category (would use actual WHOIS in production)
        domainCategory: this.categorizeDomain(domain),
      };

      return {
        ...verificationResult,
        enrichment,
      };
    } catch (error) {
      console.error("Email enrichment error:", error);
      return {
        email,
        isValid: false,
        enrichment: null,
        errors: ["Enrichment process failed"],
      };
    }
  }

  /**
   * Extract possible name from email username
   * @param {string} username - The email username part
   * @returns {Object} - Extracted name info
   */
  extractNameFromEmail(username) {
    // Remove common prefixes and numbers
    const cleanUsername = username
      .replace(
        /^(info|contact|support|admin|sales|marketing|help|service|no-reply|noreply|mail)\.?/i,
        ""
      )
      .replace(/\d+$/, "")
      .replace(/[._-]/g, " ")
      .trim();

    if (!cleanUsername) return { full: null, first: null, last: null };

    const parts = cleanUsername.split(" ");

    // If we have what looks like a name
    if (parts.length >= 1) {
      if (parts.length === 1) {
        return {
          full: parts[0],
          first: parts[0],
          last: null,
        };
      } else {
        return {
          full: cleanUsername,
          first: parts[0],
          last: parts.slice(1).join(" "),
        };
      }
    }

    return { full: null, first: null, last: null };
  }

  /**
   * Guess company name from domain
   * @param {string} domain - The email domain
   * @returns {string|null} - Guessed company name
   */
  guessCompanyFromDomain(domain) {
    // Don't guess for common email providers
    if (this.isFreeEmailProvider(domain)) {
      return null;
    }

    // Extract main part of domain
    const mainDomain = domain.split(".")[0];

    // Very basic company name transformation
    // In production, you'd use a company name database
    return mainDomain
      .replace(/-/g, " ")
      .split(" ")
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(" ");
  }

  /**
   * Check if domain is a free email provider
   * @param {string} domain - The email domain
   * @returns {boolean} - Whether it's a free provider
   */
  isFreeEmailProvider(domain) {
    const freeProviders = [
      "gmail.com",
      "yahoo.com",
      "hotmail.com",
      "outlook.com",
      "aol.com",
      "icloud.com",
      "protonmail.com",
      "mail.com",
      "zoho.com",
      "yandex.com",
      "gmx.com",
      "live.com",
    ];

    return freeProviders.includes(domain);
  }

  /**
   * Categorize domain by approximate age/reputation
   * @param {string} domain - The email domain
   * @returns {string} - Domain category
   */
  categorizeDomain(domain) {
    // In production, this would use actual WHOIS data
    // For now, just use some heuristics

    const oldDomains = [
      "ibm.com",
      "microsoft.com",
      "apple.com",
      "amazon.com",
      "google.com",
      "aol.com",
      "yahoo.com",
      "hotmail.com",
    ];

    const establishedDomains = [
      "facebook.com",
      "twitter.com",
      "linkedin.com",
      "salesforce.com",
      "adobe.com",
      "dropbox.com",
    ];

    if (oldDomains.includes(domain)) {
      return "legacy";
    } else if (establishedDomains.includes(domain)) {
      return "established";
    } else if (
      domain.endsWith(".edu") ||
      domain.endsWith(".gov") ||
      domain.endsWith(".mil")
    ) {
      return "institutional";
    } else {
      return "standard";
    }
  }
}

module.exports = new EmailVerifier();
