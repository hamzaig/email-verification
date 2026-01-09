// utils/enhancedEmailVerifier.js
const dns = require("dns");
const { promisify } = require("util");
const validator = require("validator");
const net = require("net");
const {
  getCachedMxRecords,
  cacheMxRecords,
  getCachedVerificationResult,
  cacheVerificationResult,
} = require("./cache");
const {
  getNextIp,
  getSmtpDelay,
  isDomainBlocked,
  markDomainAsBlocked,
  reportSuccessfulVerification,
  reportFailedVerification,
} = require("./ipRotation");
const { logger } = require("./monitoring");
const DisposableEmailDomains = require("./disposableEmailDomains");
const punycode = require("punycode");
const dns2 = require("dns2"); // Alternative DNS resolver

// Promisify DNS resolver
const resolveMx = promisify(dns.resolveMx).bind(dns);
const resolveTxt = promisify(dns.resolveTxt).bind(dns);

// Create alternative DNS resolver with different settings
const alternativeDnsResolver = new dns2({
  nameservers: [
    "8.8.8.8", // Google DNS
    "1.1.1.1", // Cloudflare DNS
  ],
  timeout: 5000, // 5 seconds
});

// Email verification class with advanced techniques
class EnhancedEmailVerifier {
  /**
   * Perform comprehensive email verification with multiple checks
   * @param {string} email - The email to verify
   * @param {Object} options - Verification options
   * @returns {Object} - Verification results
   */
  async verify(email, options = {}) {
    const startTime = Date.now();
    const {
      checkCache = true,
      checkSyntax = true,
      checkMx = true,
      checkDisposable = true,
      checkDomainTypos = true,
      checkCatchAll = true,
      checkSmtp = true,
      checkSpamTrap = true,
      checkRoleAccount = true,
      cacheResults = true,
      logVerification = true,
      useAlternativeDns = false,
      timeout = 10000, // 10 second timeout for overall verification
    } = options;

    try {
      // Basic result structure
      const result = {
        email,
        timestamp: new Date(),
        isValid: false,
        formatValid: false,
        hasMx: false,
        isDisposable: false,
        isCatchAll: false,
        isRoleAccount: false,
        isSpamTrap: false,
        smtpCheck: false,
        suggestion: null,
        domain: null,
        errors: [],
        details: {},
        processingTimeMs: 0,
      };

      // Create a timeout to prevent long-running verifications
      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => reject(new Error("Verification timeout")), timeout);
      });

      // Check cache first if enabled
      if (checkCache) {
        const cachedResult = await getCachedVerificationResult(email);
        if (cachedResult) {
          cachedResult.fromCache = true;
          cachedResult.processingTimeMs = Date.now() - startTime;
          return cachedResult;
        }
      }

      // Extract domain
      const parts = email.split("@");
      if (parts.length !== 2) {
        result.errors.push("Invalid email format");
        result.processingTimeMs = Date.now() - startTime;
        return result;
      }

      const [username, rawDomain] = parts;

      // Handle IDN domains (convert to punycode)
      let domain;
      try {
        domain = punycode.toASCII(rawDomain.toLowerCase());
        result.domain = domain;
      } catch (error) {
        result.errors.push("Invalid domain encoding");
        result.processingTimeMs = Date.now() - startTime;
        return result;
      }

      // 1. Format validation
      if (checkSyntax) {
        await this.performSyntaxCheck(email, result);

        // If format invalid, no need to continue
        if (!result.formatValid) {
          result.processingTimeMs = Date.now() - startTime;
          if (cacheResults) {
            await cacheVerificationResult(email, result, 86400); // Cache for 24 hours
          }
          return result;
        }
      }

      // Execute the rest of the checks in parallel for speed
      const verificationPromise = Promise.all([
        // 2. Check if domain is disposable
        checkDisposable
          ? this.checkDisposableDomain(domain, result)
          : Promise.resolve(),

        // 3. Check MX records
        checkMx
          ? this.checkMxRecords(domain, result, useAlternativeDns)
          : Promise.resolve(),

        // 4. Check for role accounts (e.g., admin@, support@)
        checkRoleAccount
          ? this.checkRoleAccount(username, result)
          : Promise.resolve(),

        // 5. Suggest corrections for common typos
        checkDomainTypos
          ? this.suggestCorrection(email, result)
          : Promise.resolve(),
      ]);

      // Wait for initial checks with timeout
      await Promise.race([verificationPromise, timeoutPromise]);

      // Only proceed with SMTP and advanced checks if MX records exist
      if (result.hasMx) {
        let domainBlocked = false;
        try {
          domainBlocked = await isDomainBlocked(domain);
        } catch (error) {
          logger.warn("Error checking domain block status:", {
            error: error.message,
            domain,
          });
        }

        result.details.smtpBlocked = domainBlocked;

        if (checkSmtp && !domainBlocked) {
          // Add a small delay if needed to respect rate limits
          const delay = await getSmtpDelay(domain);
          if (delay > 0) {
            await new Promise((resolve) => setTimeout(resolve, delay));
          }

          // 6. Perform SMTP check
          await this.performSmtpCheck(domain, email, result);
        }

        // 7. Check if it's a catch-all domain
        if (checkCatchAll && result.smtpCheck && !result.isDisposable) {
          await this.checkCatchAllDomain(domain, result);
        }

        // 8. Check for spam trap indicators
        if (checkSpamTrap) {
          await this.checkSpamTrapIndicators(email, domain, username, result);
        }
      }

      // Final validity determination
      result.isValid =
        result.formatValid &&
        result.hasMx &&
        !result.isDisposable &&
        (result.smtpCheck || result.details.smtpBlocked) &&
        !result.isSpamTrap;

      // Cache results if enabled
      if (cacheResults) {
        const cacheDuration = result.isValid ? 86400 : 43200; // 24 hours for valid, 12 hours for invalid
        await cacheVerificationResult(email, result, cacheDuration);
      }

      // Calculate processing time
      result.processingTimeMs = Date.now() - startTime;

      return result;
    } catch (error) {
      logger.error("Email verification error:", {
        error: error.message,
        email,
        stack: error.stack,
      });

      return {
        email,
        isValid: false,
        errors: ["Verification process failed: " + error.message],
        processingTimeMs: Date.now() - startTime,
      };
    }
  }

  /**
   * Perform email syntax validation
   * @param {string} email - Email to check
   * @param {Object} result - Result object to update
   */
  async performSyntaxCheck(email, result) {
    // Basic validator checks
    if (
      validator.isEmail(email, {
        allow_utf8_local_part: true,
        require_tld: true,
        allow_ip_domain: false,
      })
    ) {
      result.formatValid = true;
    } else {
      result.errors.push("Invalid email format");
      return;
    }

    // Additional syntax checks
    const parts = email.split("@");
    const [username, domain] = parts;

    // Check username length
    if (username.length > 64) {
      result.formatValid = false;
      result.errors.push("Username exceeds maximum length (64 characters)");
    }

    // Check for consecutive dots
    if (username.includes("..") || domain.includes("..")) {
      result.formatValid = false;
      result.errors.push("Consecutive dots are not allowed");
    }

    // Check for leading/trailing dots or hyphens in domain parts
    const domainParts = domain.split(".");
    for (const part of domainParts) {
      if (part.startsWith("-") || part.endsWith("-")) {
        result.formatValid = false;
        result.errors.push("Domain parts cannot start or end with hyphens");
        break;
      }
    }

    // Additional detail: Check for valid TLD
    const tld = domainParts[domainParts.length - 1];
    if (tld.length < 2) {
      result.formatValid = false;
      result.errors.push("Top-level domain is too short");
    }

    // Store detailed format checks in result
    result.details.syntax = {
      usernameLength: username.length,
      domainParts: domainParts.length,
      tld,
    };
  }

  /**
   * Check if domain is disposable
   * @param {string} domain - Domain to check
   * @param {Object} result - Result object to update
   */
  async checkDisposableDomain(domain, result) {
    result.isDisposable = DisposableEmailDomains.includes(domain);

    if (result.isDisposable) {
      result.errors.push("Disposable email address detected");
    }
  }

  /**
   * Check MX records for domain
   * @param {string} domain - Domain to check
   * @param {Object} result - Result object to update
   * @param {boolean} useAlternative - Whether to use alternative DNS resolver
   */
  async checkMxRecords(domain, result, useAlternative = false) {
    try {
      // First check cache
      const cachedMx = await getCachedMxRecords(domain);
      let mxRecords;

      if (cachedMx) {
        mxRecords = cachedMx;
      } else {
        // If not in cache, perform DNS lookup
        try {
          // Try primary DNS resolver first
          mxRecords = await resolveMx(domain);
        } catch (primaryError) {
          // If primary fails and alternative is enabled, try alternative
          if (useAlternative) {
            try {
              const alternativeResponse =
                await alternativeDnsResolver.resolveMx(domain);
              mxRecords = alternativeResponse.answers.map((a) => ({
                exchange: a.exchange,
                priority: a.priority,
              }));
            } catch (alternativeError) {
              // Both resolvers failed
              throw primaryError;
            }
          } else {
            throw primaryError;
          }
        }

        // Cache MX records
        if (mxRecords && mxRecords.length > 0) {
          await cacheMxRecords(domain, mxRecords);
        }
      }

      result.hasMx = mxRecords && mxRecords.length > 0;

      if (!result.hasMx) {
        result.errors.push("No MX records found for domain");
      } else {
        // Store MX info in details
        result.details.mx = {
          records: mxRecords.slice(0, 3), // Store first 3 MX records
          count: mxRecords.length,
        };
      }
    } catch (error) {
      logger.debug("MX lookup failed", { domain, error: error.message });
      result.errors.push("MX lookup failed: " + error.message);
      result.hasMx = false;
    }
  }

  /**
   * Perform basic SMTP validation by attempting connection
   * @param {string} domain - Domain to check
   * @param {string} email - Email to validate
   * @param {Object} result - Result object to update
   */
  async performSmtpCheck(domain, email, result) {
    try {
      // Get an optimal IP for this domain based on rate limits
      const ip = await getNextIp(domain);

      return new Promise((resolve) => {
        let resolved = false;
        let responseBuffer = "";

        try {
          const socket = new net.Socket();

          // Set timeout to 10 seconds
          socket.setTimeout(10000);

          socket.on("timeout", () => {
            if (!resolved) {
              resolved = true;
              socket.destroy();
              result.smtpCheck = false;
              result.errors.push("SMTP connection timed out");
              reportFailedVerification(domain, "timeout");
              resolve();
            }
          });

          socket.on("error", (err) => {
            if (!resolved) {
              resolved = true;
              logger.debug("SMTP connection error", {
                domain,
                error: err.message,
              });
              result.smtpCheck = false;
              result.errors.push(`SMTP connection error: ${err.message}`);
              reportFailedVerification(domain, "connection_error");
              resolve();
            }
          });

          socket.on("data", (data) => {
            if (resolved) return;

            responseBuffer += data.toString();

            // Check response codes
            // 220 = Service ready
            // 250 = Requested action taken and completed
            // 550 = Mailbox unavailable
            // 553 = Mailbox name invalid

            if (responseBuffer.includes("220")) {
              // Server greeting received, send HELO
              socket.write(`HELO ${ip}\r\n`);
            } else if (
              responseBuffer.includes("250") &&
              !responseBuffer.includes("MAIL FROM")
            ) {
              // HELO response received, send MAIL FROM
              socket.write("MAIL FROM:<verify@example.com>\r\n");
            } else if (
              responseBuffer.includes("250") &&
              responseBuffer.includes("MAIL FROM")
            ) {
              // MAIL FROM accepted, send RCPT TO
              socket.write(`RCPT TO:<${email}>\r\n`);
            } else if (
              responseBuffer.includes("250") &&
              responseBuffer.includes("RCPT TO")
            ) {
              // RCPT TO accepted, address is valid
              if (!resolved) {
                resolved = true;
                socket.destroy();
                result.smtpCheck = true;
                reportSuccessfulVerification(domain);
                resolve();
              }
            } else if (
              responseBuffer.includes("550") ||
              responseBuffer.includes("553")
            ) {
              // Address rejected
              if (!resolved) {
                resolved = true;
                socket.destroy();
                result.smtpCheck = false;
                result.errors.push("SMTP check failed: address rejected");
                reportFailedVerification(domain, "rejected");
                resolve();
              }
            } else if (responseBuffer.length > 1000) {
              // Response too long, something is wrong
              if (!resolved) {
                resolved = true;
                socket.destroy();
                result.smtpCheck = false;
                result.errors.push("SMTP check failed: unexpected response");
                reportFailedVerification(domain, "unexpected_response");
                resolve();
              }
            }
          });

          socket.on("close", () => {
            if (!resolved) {
              resolved = true;
              result.smtpCheck = false;
              result.errors.push("SMTP connection closed unexpectedly");
              reportFailedVerification(domain, "connection_closed");
              resolve();
            }
          });

          socket.on("connect", () => {
            // Connection established, wait for server greeting
            // Response handling is in the 'data' event
          });

          // Try connecting to port 25 (SMTP)
          const mxDomain = this.getMxDomain(domain, result);
          socket.connect(25, mxDomain || domain);

          // Set a timeout to force close the connection if it hangs
          setTimeout(() => {
            if (!resolved) {
              resolved = true;
              socket.destroy();
              result.smtpCheck = false;
              result.errors.push("SMTP check timed out");
              reportFailedVerification(domain, "global_timeout");
              resolve();
            }
          }, 15000);
        } catch (error) {
          if (!resolved) {
            resolved = true;
            result.smtpCheck = false;
            result.errors.push(`SMTP check failed: ${error.message}`);
            reportFailedVerification(domain, "exception");
            resolve();
          }
        }
      });
    } catch (error) {
      logger.error("Error in SMTP check", { error: error.message, domain });
      result.smtpCheck = false;
      result.errors.push(`SMTP check error: ${error.message}`);

      // If we hit rate limits, mark as valid to avoid false negatives
      if (error.message.startsWith("RATE_LIMIT")) {
        result.smtpCheck = true;
      }
    }
  }

  /**
   * Get the primary MX domain for a domain
   * @param {string} domain - Domain to get MX for
   * @param {Object} result - Result object
   * @returns {string|null} - MX domain or null
   */
  getMxDomain(domain, result) {
    if (result.details?.mx?.records && result.details.mx.records.length > 0) {
      // Sort by priority and return the lowest
      const sortedRecords = [...result.details.mx.records].sort(
        (a, b) => a.priority - b.priority
      );
      return sortedRecords[0].exchange;
    }
    return null;
  }

  /**
   * Check if domain is a catch-all domain
   * @param {string} domain - Domain to check
   * @param {Object} result - Result object to update
   */
  async checkCatchAllDomain(domain, result) {
    try {
      // Generate a random email that almost certainly doesn't exist
      const randomString = Math.random().toString(36).substring(2, 12);
      const nonExistentEmail = `${randomString}_test_nonexistent@${domain}`;

      // Create a minimal result object for the test
      const testResult = {
        smtpCheck: false,
        errors: [],
      };

      // Perform SMTP check on the non-existent email
      await this.performSmtpCheck(domain, nonExistentEmail, testResult);

      // If this random address passes SMTP validation, it's a catch-all domain
      result.isCatchAll = testResult.smtpCheck;

      if (result.isCatchAll) {
        result.details.catchAll = true;
      }
    } catch (error) {
      logger.debug("Catch-all check failed", { domain, error: error.message });
      // Don't mark as an error, just note in details
      result.details.catchAllCheckFailed = true;
    }
  }

  /**
   * Check for potential spam trap indicators
   * @param {string} email - Email to check
   * @param {string} domain - Domain part
   * @param {string} username - Username part
   * @param {Object} result - Result object to update
   */
  async checkSpamTrapIndicators(email, domain, username, result) {
    try {
      // Check for patterns commonly used in spam traps

      // 1. Random-looking usernames with no vowels
      const hasVowels = /[aeiou]/i.test(username);
      const isRandom = /^[a-z0-9]{8,}$/i.test(username) && !hasVowels;

      // 2. Domains with recent creation date (checked via WHOIS, simplified here)
      // In a real implementation, you'd use a WHOIS API or database
      const isNewDomain = false; // Placeholder

      // 3. Check for spammy TXT records
      let hasSuspiciousTxtRecords = false;
      try {
        const txtRecords = await resolveTxt(domain);
        const flatRecords = txtRecords
          .map((record) => record.join(""))
          .join(" ");

        // Check for suspicious content in TXT records
        hasSuspiciousTxtRecords = /spam|trap|honeypot/i.test(flatRecords);
      } catch (e) {
        // Ignore TXT record errors
      }

      // Combine indicators
      result.isSpamTrap = isRandom || (isNewDomain && hasSuspiciousTxtRecords);

      if (result.isSpamTrap) {
        result.errors.push("Email matches spam trap patterns");
      }

      // Store detailed indicators
      result.details.spamTrapIndicators = {
        randomUsername: isRandom,
        newDomain: isNewDomain,
        suspiciousTxtRecords: hasSuspiciousTxtRecords,
      };
    } catch (error) {
      logger.debug("Spam trap check failed", { email, error: error.message });
      // Don't mark as an error
    }
  }

  /**
   * Suggest corrections for common email typos
   * @param {string} email - The email to check
   * @param {Object} result - Result object to update
   */
  async suggestCorrection(email, result) {
    const parts = email.split("@");
    if (parts.length !== 2) return;

    const [username, domain] = parts;

    // Common domains and their corrections
    const commonDomains = {
      "gmail.com": ["gmail.com", "googlemail.com"],
      "yahoo.com": ["yahoo.com", "yahoo.co.uk", "yahoo.ca", "yahoo.fr"],
      "hotmail.com": ["hotmail.com", "outlook.com", "live.com"],
      "outlook.com": ["outlook.com", "hotmail.com"],
      "aol.com": ["aol.com"],
      "icloud.com": ["icloud.com", "me.com", "mac.com"],
      "protonmail.com": ["protonmail.com", "pm.me"],
      "gmx.com": ["gmx.com", "gmx.de"],
      "mail.com": ["mail.com"],
      "yandex.com": ["yandex.com", "yandex.ru"],
    };

    // Check for common typos
    const corrections = {
      "gmal.com": "gmail.com",
      "gamil.com": "gmail.com",
      "gnail.com": "gmail.com",
      "gmial.com": "gmail.com",
      "gmail.co": "gmail.com",
      "gmail.con": "gmail.com",
      "gmail.om": "gmail.com",
      "gmail.cm": "gmail.com",
      "gmaill.com": "gmail.com",
      "gemail.com": "gmail.com",
      "gmai.com": "gmail.com",
      "gmali.com": "gmail.com",
      "yahooo.com": "yahoo.com",
      "yaho.com": "yahoo.com",
      "yahoo.co": "yahoo.com",
      "yahoo.con": "yahoo.com",
      "yaho.co": "yahoo.com",
      "yaoo.com": "yahoo.com",
      "ymail.com": "yahoo.com",
      "hotmial.com": "hotmail.com",
      "hotmail.co": "hotmail.com",
      "hotmal.com": "hotmail.com",
      "hotmai.com": "hotmail.com",
      "hotmail.cm": "hotmail.com",
      "hotmail.con": "hotmail.com",
      "hotamail.com": "hotmail.com",
      "hotmali.com": "hotmail.com",
      "outlok.com": "outlook.com",
      "outook.com": "outlook.com",
      "outlook.co": "outlook.com",
      "outlook.con": "outlook.com",
      "iclod.com": "icloud.com",
      "icloud.co": "icloud.com",
    };

    // Check for direct corrections
    if (corrections[domain]) {
      result.suggestion = `${username}@${corrections[domain]}`;
      return;
    }

    // Check for close matches using Levenshtein distance
    const similarityThreshold = 2; // Max character difference
    for (const [correctDomain, variants] of Object.entries(commonDomains)) {
      // Skip if it's already a known domain variant
      if (variants.includes(domain)) {
        return;
      }

      // Check edit distance
      if (
        this.levenshteinDistance(domain, correctDomain) <= similarityThreshold
      ) {
        result.suggestion = `${username}@${correctDomain}`;
        return;
      }
    }
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
   * @param {Object} options - Enrichment options
   * @returns {Object} - Enrichment data
   */
  async enrich(email, options = {}) {
    try {
      // First verify the email
      const verificationResult = await this.verify(email, options);

      if (!verificationResult.isValid) {
        return {
          ...verificationResult,
          enrichment: null,
        };
      }

      const parts = email.split("@");
      const [username, domain] = parts;

      // Enhanced enrichment
      const enrichment = {
        domain,
        // Extract possible name from email
        possibleName: this.extractNameFromEmail(username),
        // Company/organization guess based on domain
        possibleCompany: this.guessCompanyFromDomain(domain),
        // Is free email provider?
        isFreeProvider: this.isFreeEmailProvider(domain),
        // Domain age category (would use actual WHOIS in production)
        domainCategory: await this.categorizeDomain(domain),
        // Social profiles search (placeholder - would use API in production)
        socialProfiles: await this.findSocialProfiles(email),
        // Breach database check (placeholder - would use API in production)
        breachData: await this.checkBreachDatabases(email),
        // Additional metadata
        metadata: {
          isRoleAccount: verificationResult.isRoleAccount,
          isCatchAll: verificationResult.isCatchAll,
          hasValidMx: verificationResult.hasMx,
        },
      };

      return {
        ...verificationResult,
        enrichment,
      };
    } catch (error) {
      logger.error("Email enrichment error:", error);
      return {
        email,
        isValid: false,
        enrichment: null,
        errors: ["Enrichment process failed: " + error.message],
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
          full: this.capitalizeFirstLetter(parts[0]),
          first: this.capitalizeFirstLetter(parts[0]),
          last: null,
        };
      } else {
        return {
          full: parts.map(this.capitalizeFirstLetter).join(" "),
          first: this.capitalizeFirstLetter(parts[0]),
          last: parts.slice(1).map(this.capitalizeFirstLetter).join(" "),
        };
      }
    }

    return { full: null, first: null, last: null };
  }

  /**
   * Capitalize first letter of a string
   * @param {string} str - String to capitalize
   * @returns {string} - Capitalized string
   */
  capitalizeFirstLetter(str) {
    if (!str || typeof str !== "string") return "";
    return str.charAt(0).toUpperCase() + str.slice(1);
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

    // Extract domain name without TLD
    const domainParts = domain.split(".");
    if (domainParts.length < 2) return null;

    const tld = domainParts.pop(); // Remove TLD
    const sld = domainParts.pop(); // Get second-level domain

    // Common TLDs to check if we need to get third-level domain
    const countryTlds = [
      "co.uk",
      "com.au",
      "co.nz",
      "co.jp",
      "co.za",
      "com.br",
    ];
    if (countryTlds.includes(`${sld}.${tld}`) && domainParts.length > 0) {
      // For domains like company.co.uk, use the third-level domain
      return this.formatCompanyName(domainParts.pop());
    }

    // Return formatted company name
    return this.formatCompanyName(sld);
  }

  /**
   * Format a domain part as a company name
   * @param {string} domainPart - Domain part to format
   * @returns {string} - Formatted company name
   */
  formatCompanyName(domainPart) {
    if (!domainPart) return null;

    // Replace hyphens and underscores with spaces
    let companyName = domainPart.replace(/[-_]/g, " ");

    // Capitalize words
    companyName = companyName
      .split(" ")
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(" ");

    return companyName;
  }

  /**
   * Check if domain is a free email provider
   * @param {string} domain - The email domain
   * @returns {boolean} - Whether it's a free provider
   */
  isFreeEmailProvider(domain) {
    const freeProviders = [
      "gmail.com",
      "googlemail.com",
      "yahoo.com",
      "yahoo.co.uk",
      "yahoo.ca",
      "hotmail.com",
      "outlook.com",
      "live.com",
      "aol.com",
      "icloud.com",
      "me.com",
      "mac.com",
      "protonmail.com",
      "pm.me",
      "mail.com",
      "zoho.com",
      "yandex.com",
      "gmx.com",
      "gmx.de",
      "gmx.net",
      "tutanota.com",
      "tutanota.de",
      "tutamail.com",
      "tuta.io",
      "mailinator.com",
      "mail.ru",
      "rambler.ru",
      "inbox.com",
      "inbox.ru",
    ];

    return freeProviders.includes(domain.toLowerCase());
  }

  /**
   * Categorize domain by approximate age/reputation
   * @param {string} domain - The email domain
   * @returns {string} - Domain category
   */
  async categorizeDomain(domain) {
    // In production, this would use actual WHOIS data or domain age API
    // This is a simplified implementation

    const legacyDomains = [
      "ibm.com",
      "microsoft.com",
      "apple.com",
      "amazon.com",
      "google.com",
      "aol.com",
      "yahoo.com",
      "hotmail.com",
      "oracle.com",
      "intel.com",
      "cisco.com",
      "hp.com",
      "dell.com",
      "sap.com",
    ];

    const establishedDomains = [
      "facebook.com",
      "twitter.com",
      "linkedin.com",
      "instagram.com",
      "salesforce.com",
      "adobe.com",
      "dropbox.com",
      "slack.com",
      "spotify.com",
      "netflix.com",
      "uber.com",
      "airbnb.com",
    ];

    if (legacyDomains.includes(domain)) {
      return "legacy";
    } else if (establishedDomains.includes(domain)) {
      return "established";
    } else if (
      domain.endsWith(".edu") ||
      domain.endsWith(".gov") ||
      domain.endsWith(".mil")
    ) {
      return "institutional";
    } else if (domain.endsWith(".org") || domain.endsWith(".net")) {
      return "organization";
    } else {
      return "standard";
    }
  }

  /**
   * Find potential social profiles matching the email (placeholder)
   * @param {string} email - Email to find profiles for
   * @returns {Object} - Social profile data
   */
  async findSocialProfiles(email) {
    // In a production system, this would use a social media API or database
    // This is just a placeholder implementation
    return {
      found: false,
      message: "Social profile lookup requires a paid API integration",
      profiles: [],
    };
  }

  /**
   * Check breach databases for this email (placeholder)
   * @param {string} email - Email to check
   * @returns {Object} - Breach data
   */
  async checkBreachDatabases(email) {
    // In a production system, this would use a service like HaveIBeenPwned
    // This is just a placeholder implementation
    return {
      found: false,
      message: "Breach data requires a paid API integration",
      breaches: [],
    };
  }

  /**
   * Perform verification on a batch of emails
   * @param {Array} emails - Array of emails to verify
   * @param {Object} options - Verification options
   * @returns {Array} - Array of verification results
   */
  async verifyBatch(emails, options = {}) {
    const results = [];
    const concurrency = options.concurrency || 5;

    // Process in batches to avoid overwhelming servers
    for (let i = 0; i < emails.length; i += concurrency) {
      const batch = emails.slice(i, i + concurrency);
      const batchPromises = batch.map((email) => this.verify(email, options));

      // Wait for batch to complete
      const batchResults = await Promise.all(batchPromises);
      results.push(...batchResults);

      // Add a small delay between batches to be nice to mail servers
      if (i + concurrency < emails.length) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }

    return results;
  }
}

module.exports = new EnhancedEmailVerifier();
