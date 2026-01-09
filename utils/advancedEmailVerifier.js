const dns = require("dns");
const { promisify } = require("util");
const validator = require("validator");
const net = require("net");
const tls = require("tls");
const dns2 = require("dns2");
const punycode = require("punycode");
const { logger } = require("./monitoring");

// Promisify DNS resolver
const resolveMx = promisify(dns.resolveMx).bind(dns);
const resolveTxt = promisify(dns.resolveTxt).bind(dns);
const resolveNs = promisify(dns.resolveNs).bind(dns);
const resolveSoa = promisify(dns.resolveSoa).bind(dns);

// Create alternative DNS resolver
const alternativeDnsResolver = new dns2({
  nameservers: [
    "8.8.8.8", // Google DNS
    "1.1.1.1", // Cloudflare DNS
    "9.9.9.9", // Quad9 DNS
  ],
  timeout: 5000,
});

class AdvancedEmailVerifier {
  /**
   * Perform comprehensive email verification with multiple checks
   * @param {string} email - The email to verify
   * @param {Object} options - Verification options
   * @returns {Object} - Verification results
   */
  async verify(email, options = {}) {
    const startTime = Date.now();
    const {
      checkSyntax = true,
      checkMx = true,
      checkDisposable = true,
      checkDomainTypos = true,
      checkCatchAll = true,
      checkSmtp = true,
      checkSpamTrap = true,
      checkRoleAccount = true,
      checkDns = true,
      checkSpf = true,
      checkDkim = true,
      checkDmarc = true,
      checkMxPriority = true,
      checkDomainAge = true,
      checkDomainReputation = true,
      checkMailbox = true,
      timeout = 30000,
    } = options;

    try {
      // Basic result structure
      const result = {
        email,
        timestamp: new Date(),
        isValid: false,
        isLive: false,
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
        details: {
          syntax: {},
          mx: {},
          dns: {},
          security: {},
          reputation: {},
          mailbox: {},
        },
        processingTimeMs: 0,
      };

      // Extract domain
      const parts = email.split("@");
      if (parts.length !== 2) {
        result.errors.push("Invalid email format");
        return result;
      }

      const [username, domain] = parts;
      result.domain = domain.toLowerCase();

      // Perform all checks
      if (checkSyntax) {
        await this.performSyntaxCheck(email, result);
      }

      if (checkDns) {
        await this.performDnsChecks(domain, result);
      }

      if (checkMx) {
        await this.checkMxRecords(domain, result);
      }

      if (checkDisposable) {
        await this.checkDisposableDomain(domain, result);
      }

      if (checkSpf) {
        await this.checkSpfRecord(domain, result);
      }

      if (checkDkim) {
        await this.checkDkimRecord(domain, result);
      }

      if (checkDmarc) {
        await this.checkDmarcRecord(domain, result);
      }

      if (checkSmtp) {
        await this.performSmtpCheck(domain, email, result);
      }

      if (checkCatchAll) {
        await this.checkCatchAllDomain(domain, result);
      }

      if (checkSpamTrap) {
        await this.checkSpamTrapIndicators(email, domain, username, result);
      }

      if (checkRoleAccount) {
        await this.checkRoleAccount(email, domain, username, result);
      }

      if (checkDomainAge) {
        await this.checkDomainAge(domain, result);
      }

      if (checkDomainReputation) {
        await this.checkDomainReputation(domain, result);
      }

      if (checkMailbox) {
        await this.checkMailboxExistence(domain, email, result);
      }

      // Determine final validity
      result.isValid = this.determineValidity(result);
      result.isLive = this.determineLiveness(result);
      result.processingTimeMs = Date.now() - startTime;

      return result;
    } catch (error) {
      logger.error("Email verification error", { error: error.message });
      return {
        email,
        isValid: false,
        isLive: false,
        errors: ["Verification process failed: " + error.message],
        processingTimeMs: Date.now() - startTime,
      };
    }
  }

  /**
   * Perform syntax validation
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
      result.details.syntax.valid = true;
    } else {
      result.errors.push("Invalid email format");
      result.details.syntax.valid = false;
      return;
    }

    const parts = email.split("@");
    const [username, domain] = parts;

    // Check username length
    result.details.syntax.usernameLength = username.length;
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

    // Check TLD
    const tld = domainParts[domainParts.length - 1];
    result.details.syntax.tld = tld;
    if (tld.length < 2) {
      result.formatValid = false;
      result.errors.push("Top-level domain is too short");
    }
  }

  /**
   * Perform DNS checks
   */
  async performDnsChecks(domain, result) {
    try {
      // Check NS records
      const nsRecords = await resolveNs(domain);
      result.details.dns.nsRecords = nsRecords;
      result.details.dns.hasNs = nsRecords.length > 0;

      // Check SOA record
      const soaRecord = await resolveSoa(domain);
      result.details.dns.soaRecord = soaRecord;
      result.details.dns.hasSoa = !!soaRecord;

      // Check for common DNS issues
      if (!result.details.dns.hasNs) {
        result.errors.push("No nameservers found for domain");
      }

      if (!result.details.dns.hasSoa) {
        result.errors.push("No SOA record found for domain");
      }
    } catch (error) {
      result.errors.push("DNS lookup failed: " + error.message);
    }
  }

  /**
   * Check MX records with priority analysis
   */
  async checkMxRecords(domain, result) {
    try {
      const mxRecords = await resolveMx(domain);
      result.hasMx = mxRecords && mxRecords.length > 0;

      if (!result.hasMx) {
        result.errors.push("No MX records found for domain");
      } else {
        // Store MX info in details
        result.details.mx.records = mxRecords;
        result.details.mx.count = mxRecords.length;

        // Analyze MX priorities
        const priorities = mxRecords.map((r) => r.priority);
        result.details.mx.priorityAnalysis = {
          min: Math.min(...priorities),
          max: Math.max(...priorities),
          average: priorities.reduce((a, b) => a + b, 0) / priorities.length,
          hasLowPriority: priorities.some((p) => p > 50),
          hasHighPriority: priorities.some((p) => p < 10),
        };

        // Check for common mail server providers
        const commonProviders = [
          "google.com",
          "outlook.com",
          "yahoo.com",
          "secureserver.net",
          "amazonaws.com",
        ];

        result.details.mx.providerAnalysis = mxRecords.map((record) => {
          const provider = commonProviders.find((p) =>
            record.exchange.toLowerCase().includes(p)
          );
          return {
            exchange: record.exchange,
            priority: record.priority,
            provider: provider || "unknown",
            isCommon: !!provider,
          };
        });
      }
    } catch (error) {
      result.errors.push("MX lookup failed: " + error.message);
      result.hasMx = false;
    }
  }

  /**
   * Check SPF record
   */
  async checkSpfRecord(domain, result) {
    try {
      const txtRecords = await resolveTxt(domain);
      const spfRecord = txtRecords.find((record) =>
        record[0].toLowerCase().startsWith("v=spf1")
      );

      if (spfRecord) {
        result.details.security.spf = {
          exists: true,
          record: spfRecord[0],
          mechanisms: this.parseSpfMechanisms(spfRecord[0]),
        };
      } else {
        result.details.security.spf = {
          exists: false,
        };
        result.errors.push("No SPF record found");
      }
    } catch (error) {
      result.errors.push("SPF check failed: " + error.message);
    }
  }

  /**
   * Check DKIM record
   */
  async checkDkimRecord(domain, result) {
    try {
      // Check for common DKIM selectors
      const commonSelectors = ["default", "google", "selector1", "selector2"];
      const dkimRecords = [];

      for (const selector of commonSelectors) {
        try {
          const dkimDomain = `${selector}._domainkey.${domain}`;
          const txtRecords = await resolveTxt(dkimDomain);
          if (txtRecords && txtRecords.length > 0) {
            dkimRecords.push({
              selector,
              record: txtRecords[0][0],
            });
          }
        } catch (e) {
          // Ignore errors for non-existent selectors
        }
      }

      result.details.security.dkim = {
        exists: dkimRecords.length > 0,
        records: dkimRecords,
      };

      if (dkimRecords.length === 0) {
        result.errors.push("No DKIM records found");
      }
    } catch (error) {
      result.errors.push("DKIM check failed: " + error.message);
    }
  }

  /**
   * Check DMARC record
   */
  async checkDmarcRecord(domain, result) {
    try {
      const dmarcDomain = `_dmarc.${domain}`;
      const txtRecords = await resolveTxt(dmarcDomain);
      const dmarcRecord = txtRecords.find((record) =>
        record[0].toLowerCase().startsWith("v=dmarc1")
      );

      if (dmarcRecord) {
        result.details.security.dmarc = {
          exists: true,
          record: dmarcRecord[0],
          policy: this.parseDmarcPolicy(dmarcRecord[0]),
        };
      } else {
        result.details.security.dmarc = {
          exists: false,
        };
        result.errors.push("No DMARC record found");
      }
    } catch (error) {
      result.errors.push("DMARC check failed: " + error.message);
    }
  }

  /**
   * Perform enhanced SMTP check
   */
  async performSmtpCheck(domain, email, result) {
    try {
      const mxDomain = this.getMxDomain(domain, result);
      if (!mxDomain) {
        result.smtpCheck = false;
        result.errors.push("No valid MX domain found for SMTP check");
        return;
      }

      // Try different ports and protocols
      const ports = [25, 587, 465];
      const protocols = ["smtp", "smtps"];
      let success = false;

      for (const port of ports) {
        for (const protocol of protocols) {
          try {
            const checkResult = await this.trySmtpConnection(
              mxDomain,
              port,
              protocol,
              email
            );
            if (checkResult.success) {
              success = true;
              result.smtpCheck = true;
              result.details.mailbox.smtpCheck = {
                success: true,
                port,
                protocol,
                response: checkResult.response,
              };
              break;
            }
          } catch (error) {
            // Continue to next combination
          }
        }
        if (success) break;
      }

      if (!success) {
        result.smtpCheck = false;
        result.errors.push("SMTP check failed on all ports and protocols");
      }
    } catch (error) {
      result.smtpCheck = false;
      result.errors.push("SMTP check failed: " + error.message);
    }
  }

  /**
   * Try SMTP connection with specific port and protocol
   */
  async trySmtpConnection(mxDomain, port, protocol, email) {
    return new Promise((resolve, reject) => {
      const socket =
        protocol === "smtps"
          ? tls.connect(port, mxDomain, { rejectUnauthorized: false })
          : net.connect(port, mxDomain);

      let responseBuffer = "";
      let timeout = setTimeout(() => {
        socket.destroy();
        reject(new Error("Connection timeout"));
      }, 10000);

      socket.on("data", (data) => {
        responseBuffer += data.toString();

        if (responseBuffer.includes("220")) {
          socket.write(`HELO ${mxDomain}\r\n`);
        } else if (
          responseBuffer.includes("250") &&
          !responseBuffer.includes("MAIL FROM")
        ) {
          socket.write("MAIL FROM:<verify@example.com>\r\n");
        } else if (
          responseBuffer.includes("250") &&
          responseBuffer.includes("MAIL FROM")
        ) {
          socket.write(`RCPT TO:<${email}>\r\n`);
        } else if (
          responseBuffer.includes("250") &&
          responseBuffer.includes("RCPT TO")
        ) {
          clearTimeout(timeout);
          socket.destroy();
          resolve({ success: true, response: responseBuffer });
        } else if (
          responseBuffer.includes("550") ||
          responseBuffer.includes("553")
        ) {
          clearTimeout(timeout);
          socket.destroy();
          resolve({ success: false, response: responseBuffer });
        }
      });

      socket.on("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });

      socket.on("close", () => {
        clearTimeout(timeout);
        reject(new Error("Connection closed"));
      });
    });
  }

  /**
   * Check mailbox existence using multiple methods
   */
  async checkMailboxExistence(domain, email, result) {
    try {
      // Method 1: SMTP VRFY command (if supported)
      const vrfyResult = await this.tryVrfyCommand(domain, email);
      result.details.mailbox.vrfyCheck = vrfyResult;

      // Method 2: Check for common error patterns
      const errorPatterns = await this.checkErrorPatterns(domain, email);
      result.details.mailbox.errorPatterns = errorPatterns;

      // Method 3: Check for catch-all configuration
      const catchAllResult = await this.checkCatchAllDomain(domain, result);
      result.details.mailbox.catchAll = catchAllResult;

      // Determine mailbox existence
      result.details.mailbox.exists = this.determineMailboxExistence(
        vrfyResult,
        errorPatterns,
        catchAllResult
      );
    } catch (error) {
      result.errors.push("Mailbox check failed: " + error.message);
    }
  }

  /**
   * Try VRFY command
   */
  async tryVrfyCommand(domain, email) {
    // Implementation would be similar to SMTP check but using VRFY command
    // This is often disabled on mail servers for security reasons
    return { supported: false, result: null };
  }

  /**
   * Check for common error patterns
   */
  async checkErrorPatterns(domain, email) {
    // Implementation would check for common error messages
    // that indicate mailbox existence or non-existence
    return { patterns: [], confidence: 0 };
  }

  /**
   * Determine mailbox existence based on multiple checks
   */
  determineMailboxExistence(vrfyResult, errorPatterns, catchAllResult) {
    // Combine results from different checks to determine existence
    // This is a simplified version - in production, you'd want more sophisticated logic
    return vrfyResult.supported
      ? vrfyResult.result
      : errorPatterns.confidence > 0.7
      ? true
      : false;
  }

  /**
   * Determine final validity
   */
  determineValidity(result) {
    // Basic validity checks
    const basicChecks = [
      result.formatValid,
      result.hasMx,
      !result.isDisposable,
      result.details.security.spf?.exists,
      result.details.security.dkim?.exists,
      result.details.security.dmarc?.exists,
    ];

    return basicChecks.every((check) => check === true);
  }

  /**
   * Determine if email is live
   */
  determineLiveness(result) {
    // More strict checks for liveness
    const livenessChecks = [
      result.smtpCheck,
      result.details.mailbox.exists,
      !result.isCatchAll,
      !result.isRoleAccount,
      !result.isSpamTrap,
    ];

    return livenessChecks.every((check) => check === true);
  }

  /**
   * Parse SPF mechanisms
   */
  parseSpfMechanisms(spfRecord) {
    const mechanisms = [];
    const parts = spfRecord.split(" ");

    for (const part of parts) {
      if (
        part.startsWith("+") ||
        part.startsWith("-") ||
        part.startsWith("~") ||
        part.startsWith("?")
      ) {
        mechanisms.push({
          qualifier: part[0],
          mechanism: part.substring(1),
        });
      }
    }

    return mechanisms;
  }

  /**
   * Parse DMARC policy
   */
  parseDmarcPolicy(dmarcRecord) {
    const policy = {
      p: "none",
      sp: "none",
      pct: 100,
      rua: [],
      ruf: [],
    };

    const parts = dmarcRecord.split(";");
    for (const part of parts) {
      const [key, value] = part.trim().split("=");
      if (key && value) {
        switch (key.toLowerCase()) {
          case "p":
            policy.p = value.toLowerCase();
            break;
          case "sp":
            policy.sp = value.toLowerCase();
            break;
          case "pct":
            policy.pct = parseInt(value, 10);
            break;
          case "rua":
            policy.rua = value.split(",").map((uri) => uri.trim());
            break;
          case "ruf":
            policy.ruf = value.split(",").map((uri) => uri.trim());
            break;
        }
      }
    }

    return policy;
  }

  /**
   * Get primary MX domain
   */
  getMxDomain(domain, result) {
    if (result.details.mx.records && result.details.mx.records.length > 0) {
      // Sort by priority and return the lowest priority (highest priority number)
      const sorted = [...result.details.mx.records].sort(
        (a, b) => a.priority - b.priority
      );
      return sorted[0].exchange;
    }
    return null;
  }

  /**
   * Check if domain is disposable
   */
  async checkDisposableDomain(domain, result) {
    try {
      // List of known disposable email domains
      const disposableDomains = [
        "tempmail.com",
        "temp-mail.org",
        "guerrillamail.com",
        "mailinator.com",
        "yopmail.com",
        "trashmail.com",
        "10minutemail.com",
        "throwawaymail.com",
      ];

      result.isDisposable = disposableDomains.includes(domain.toLowerCase());

      if (result.isDisposable) {
        result.errors.push("Domain is a known disposable email provider");
      }
    } catch (error) {
      result.errors.push("Disposable domain check failed: " + error.message);
    }
  }

  /**
   * Check for catch-all domain configuration
   */
  async checkCatchAllDomain(domain, result) {
    try {
      const randomEmail = `test-${Date.now()}@${domain}`;
      const checkResult = await this.trySmtpConnection(
        this.getMxDomain(domain, result),
        25,
        "smtp",
        randomEmail
      );

      result.isCatchAll = checkResult.success;

      if (result.isCatchAll) {
        result.errors.push("Domain appears to be configured as catch-all");
      }

      return result.isCatchAll;
    } catch (error) {
      result.errors.push("Catch-all check failed: " + error.message);
      return false;
    }
  }

  /**
   * Check for spam trap indicators
   */
  async checkSpamTrapIndicators(email, domain, username, result) {
    try {
      // Common spam trap patterns
      const spamTrapPatterns = [
        /^(admin|postmaster|abuse|spam|noreply)@/i,
        /^[a-z0-9]{20,}@/i,
        /^(test|info|mail|email)@/i,
      ];

      result.isSpamTrap = spamTrapPatterns.some((pattern) =>
        pattern.test(email)
      );

      if (result.isSpamTrap) {
        result.errors.push("Email matches known spam trap patterns");
      }
    } catch (error) {
      result.errors.push("Spam trap check failed: " + error.message);
    }
  }

  /**
   * Check if email is a role account
   */
  async checkRoleAccount(email, domain, username, result) {
    try {
      // Common role account usernames
      const roleAccounts = [
        "admin",
        "administrator",
        "webmaster",
        "hostmaster",
        "postmaster",
        "abuse",
        "security",
        "support",
        "info",
        "contact",
        "sales",
        "marketing",
        "help",
        "noreply",
        "no-reply",
      ];

      result.isRoleAccount = roleAccounts.includes(username.toLowerCase());

      if (result.isRoleAccount) {
        result.errors.push("Email appears to be a role account");
      }
    } catch (error) {
      result.errors.push("Role account check failed: " + error.message);
    }
  }

  /**
   * Check domain age and registration info
   */
  async checkDomainAge(domain, result) {
    try {
      const soaRecord = result.details.dns.soaRecord;
      if (soaRecord) {
        const now = Date.now();
        const serial = soaRecord.serial.toString();
        // Try to parse serial as YYYYMMDD format
        const year = parseInt(serial.substring(0, 4));
        const month = parseInt(serial.substring(4, 6));
        const day = parseInt(serial.substring(6, 8));

        if (!isNaN(year) && !isNaN(month) && !isNaN(day)) {
          const registrationDate = new Date(year, month - 1, day);
          const ageInDays = Math.floor(
            (now - registrationDate) / (1000 * 60 * 60 * 24)
          );

          result.details.domain = {
            ...result.details.domain,
            age: {
              days: ageInDays,
              registrationDate: registrationDate.toISOString(),
            },
          };

          if (ageInDays < 30) {
            result.errors.push("Domain is less than 30 days old");
          }
        }
      }
    } catch (error) {
      result.errors.push("Domain age check failed: " + error.message);
    }
  }

  /**
   * Check domain reputation
   */
  async checkDomainReputation(domain, result) {
    try {
      // Basic reputation check based on DNS and security records
      const reputationScore = this.calculateReputationScore(result);

      result.details.reputation = {
        score: reputationScore,
        factors: {
          hasDns: result.details.dns.hasNs && result.details.dns.hasSoa,
          hasMx: result.hasMx,
          hasSpf: result.details.security.spf?.exists,
          hasDkim: result.details.security.dkim?.exists,
          hasDmarc: result.details.security.dmarc?.exists,
          isDisposable: result.isDisposable,
          isCatchAll: result.isCatchAll,
          isSpamTrap: result.isSpamTrap,
          isRoleAccount: result.isRoleAccount,
        },
      };

      if (reputationScore < 5) {
        result.errors.push("Domain has a low reputation score");
      }
    } catch (error) {
      result.errors.push("Domain reputation check failed: " + error.message);
    }
  }

  /**
   * Calculate domain reputation score
   */
  calculateReputationScore(result) {
    let score = 0;

    // DNS configuration (max 3 points)
    if (result.details.dns.hasNs) score += 1;
    if (result.details.dns.hasSoa) score += 1;
    if (result.hasMx) score += 1;

    // Security records (max 3 points)
    if (result.details.security.spf?.exists) score += 1;
    if (result.details.security.dkim?.exists) score += 1;
    if (result.details.security.dmarc?.exists) score += 1;

    // Negative factors
    if (result.isDisposable) score -= 2;
    if (result.isCatchAll) score -= 1;
    if (result.isSpamTrap) score -= 2;
    if (result.isRoleAccount) score -= 1;

    // Normalize score to 0-10 range
    return Math.max(0, Math.min(10, score));
  }
}

module.exports = new AdvancedEmailVerifier();
