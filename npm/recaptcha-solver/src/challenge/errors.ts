// SPDX-License-Identifier: AGPL-3.0-only

export class ChallengeError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class ChallengeElementNotFoundError extends ChallengeError {}

export class ChallengeImageDownloadError extends ChallengeError {}
