# Effect v4 for the application, pure functions for translation

The application is built on Effect v4: its services, configuration schemas, typed errors, streams and HTTP client. Translation, thinking and payload rules are the exception. They are pure synchronous functions over parsed JSON, shaped like their Go counterparts, because that keeps them comparable to the Go code and to golden fixtures. Wrapping them in effects to match the rest of the codebase would undo that.
