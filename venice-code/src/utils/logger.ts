/**
 * Logging utilities
 */

import chalk from 'chalk';
import ora, { type Ora } from 'ora';

let spinner: Ora | null = null;

export function log(message: string): void {
  if (spinner) {
    spinner.stop();
  }
  console.log(message);
  if (spinner) {
    spinner.start();
  }
}

export function logInfo(message: string): void {
  log(chalk.blue('ℹ') + ' ' + message);
}

export function logSuccess(message: string): void {
  log(chalk.green('✔') + ' ' + message);
}

export function logWarning(message: string): void {
  log(chalk.yellow('⚠') + ' ' + message);
}

export function logError(message: string): void {
  log(chalk.red('✖') + ' ' + message);
}

export function logDebug(message: string, verbose = false): void {
  if (verbose) {
    log(chalk.gray('[DEBUG] ' + message));
  }
}

export function startSpinner(text: string): Ora {
  if (spinner) {
    spinner.stop();
  }
  spinner = ora(text).start();
  return spinner;
}

export function updateSpinner(text: string): void {
  if (spinner) {
    spinner.text = text;
  }
}

export function stopSpinner(success = true, text?: string): void {
  if (spinner) {
    if (success) {
      spinner.succeed(text);
    } else {
      spinner.fail(text);
    }
    spinner = null;
  }
}

export function clearSpinner(): void {
  if (spinner) {
    spinner.stop();
    spinner = null;
  }
}

export { chalk };
