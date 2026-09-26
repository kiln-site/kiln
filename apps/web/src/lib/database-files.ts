// Kept tiny so the files page can route database files without loading the
// lazily imported viewer.
const DATABASE_FILE_PATTERN = /\.(?:db|sqlite|sqlite3|db3|s3db|sl3)$/iu

export function isDatabaseFilePath(path: string) {
  return DATABASE_FILE_PATTERN.test(path)
}
