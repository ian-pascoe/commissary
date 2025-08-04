# Commissary

A modern, cross-platform desktop application built with Tauri, React, and TypeScript. Commissary provides a secure and efficient workspace for managing AI-powered workflows, chats, and configurations.

## 🚀 Features

- **Cross-Platform Desktop App**: Built with Tauri for native performance
- **AI-Powered**: Integrated support for multiple AI providers (OpenAI, Anthropic, Google, Groq)
- **Secure Authentication**: Better-auth integration with secure credential management
- **Real-time Chat**: Built-in chat interface with AI providers
- **Database Storage**: Local and remote database support with Drizzle ORM
- **Modern UI**: Clean, responsive interface built with Radix UI and Tailwind CSS
- **Type Safety**: Full TypeScript support with end-to-end type safety

## 📋 Prerequisites

- **Bun**: This project uses Bun as its package manager and runtime
- **Rust**: Required for Tauri development
- **Node.js**: For development dependencies (optional, as Bun provides Node.js compatibility)

## 🛠️ Installation

### 1. Clone the repository
```bash
git clone <repository-url>
cd commissary
```

### 2. Install dependencies
```bash
bun install
```

### 3. Environment setup
Copy the example environment file and configure your settings:
```bash
cp .env.example .env
```

Edit `.env` with your configuration:
```env
# Database
DATABASE_URL=your-database-url

# AI Provider Keys (choose your providers)
OPENAI_API_KEY=your-openai-key
ANTHROPIC_API_KEY=your-anthropic-key
GOOGLE_API_KEY=your-google-key
GROQ_API_KEY=your-groq-key

# Auth
BETTER_AUTH_SECRET=your-auth-secret
BETTER_AUTH_URL=http://localhost:3000
```

### 4. Database setup
Generate database schemas and run migrations:
```bash
# Generate schema files
bun run auth:generate

# Run database migrations
bun run db:generate
```

### 5. Start development
```bash
bun run dev
```

## 🏗️ Development

### Available Scripts

| Command | Description |
|---------|-------------|
| `bun run dev` | Start development server |
| `bun run build` | Build for production |
| `bun run lint` | Lint code |
| `bun run lint:fix` | Fix linting issues |
| `bun run format` | Format code with Biome |
| `bun run type-check` | Type check with TypeScript |
| `bun run test` | Run tests with Vitest |
| `bun run clean` | Clean build artifacts |

### Database Commands

| Command | Description |
|---------|-------------|
| `bun run db:local` | Local database operations |
| `bun run db:remote` | Remote database operations |
| `bun run db:generate` | Generate migrations for both databases |

## 🏛️ Architecture

### Tech Stack

- **Frontend**: React 19, TypeScript, TanStack Router
- **Desktop**: Tauri (Rust)
- **Styling**: Tailwind CSS, Radix UI
- **State Management**: TanStack Query, Zustand
- **Backend**: Hono (Edge runtime)
- **Database**: Drizzle ORM (SQLite/PostgreSQL)
- **Authentication**: Better-auth
- **AI Integration**: Vercel AI SDK

### Project Structure

```
commissary/
├── src/                    # React frontend
│   ├── components/         # Reusable UI components
│   ├── contexts/           # React contexts
│   ├── hooks/             # Custom React hooks
│   ├── lib/               # Core libraries and utilities
│   ├── routes/            # TanStack Router routes
│   ├── schemas/           # Zod schemas for validation
│   ├── server/            # Hono backend routes
│   ├── styles/            # Global styles and themes
│   ├── types/             # TypeScript type definitions
│   └── utils/             # Utility functions
├── src-tauri/             # Tauri Rust backend
├── public/                # Static assets
├── drizzle/              # Database schemas and migrations
└── .alchemy/              # Build configuration
```

### Key Components

#### Frontend Architecture
- **TanStack Router**: File-based routing with type-safe navigation
- **TanStack Query**: Server state management with caching and synchronization
- **TanStack Form**: Type-safe form handling with validation
- **Better-auth**: Secure authentication with multiple providers

#### Backend Architecture
- **Hono**: Fast, lightweight web framework
- **Drizzle ORM**: Type-safe database queries
- **Zod**: Runtime type validation
- **AI SDK**: Unified interface for multiple AI providers

## 🎯 Core Features

### Authentication
- **Better-auth integration** with secure session management
- **Multiple providers** support (Google, GitHub, etc.)
- **Secure credential storage** using Tauri's secure storage
- **JWT tokens** with automatic refresh

### Database Management
- **Dual database support**: Local SQLite and remote PostgreSQL
- **Schema-first development** with Zod validation
- **Migration system** with Drizzle Kit
- **Type-safe queries** with Drizzle ORM

### AI Integration
- **Multiple providers**: OpenAI, Anthropic, Google, Groq
- **Real-time chat** with streaming responses
- **Context management** for conversation history
- **Tool calling** support for AI agents

### UI/UX
- **Modern design system** with Radix UI components
- **Dark/light mode** support
- **Responsive layouts** that work on all screen sizes
- **Smooth animations** and transitions
- **Keyboard shortcuts** for power users

## 🔧 Configuration

### Environment Variables

| Variable | Description | Required |
|----------|-----------|----------|
| `DATABASE_URL` | Database connection string | Yes |
| `OPENAI_API_KEY` | OpenAI API key | No |
| `ANTHROPIC_API_KEY` | Anthropic API key | No |
| `GOOGLE_API_KEY` | Google AI API key | No |
| `GROQ_API_KEY` | Groq API key | No |
| `BETTER_AUTH_SECRET` | Auth secret key | Yes |
| `BETTER_AUTH_URL` | Auth callback URL | Yes |

### Database Configuration

The app supports both local and remote databases:

- **Local**: SQLite for offline development
- **Remote**: PostgreSQL for production/cloud deployment

Configure in `drizzle.local.config.ts` and `drizzle.remote.config.ts`.

## 🚀 Deployment

### Building for Production

```bash
# Build the application
bun run build

# The built application will be in the dist/ directory
```

### Tauri Build

```bash
# Build for current platform
bunx tauri build

# Build for specific target
bunx tauri build --target x86_64-apple-darwin
```

## 🧪 Testing

### Running Tests

```bash
# Run all tests
bun run test

# Run tests in watch mode
bun run test --watch

# Run specific test file
bun run test src/components/my-component.test.tsx
```

### Test Structure

- **Unit tests**: `*.test.ts` or `*.test.tsx` files
- **Component tests**: Using React Testing Library
- **API tests**: Mock server responses
- **E2E tests**: Tauri integration tests

## 🐛 Debugging

### Development Debugging

1. **Frontend debugging**: Use browser DevTools (F12)
2. **Backend debugging**: Use console.log or debugging tools
3. **Tauri debugging**: Use `bun run tauri dev -- --devtools`

### Production Debugging

1. **Logs**: Check Tauri logs in the application
2. **Error reporting**: Use Sentry or similar service
3. **User feedback**: Implement error boundaries and user reporting

## 📚 Documentation

### Code Style Guidelines

- **TypeScript**: Strict mode enabled
- **Formatting**: Biome with consistent styling
- **Imports**: Use `~` alias for src/ directory
- **Naming**: camelCase for variables, PascalCase for components
- **File structure**: Feature-based organization

### Component Patterns

- **Function components**: Use React.FC for type safety
- **Props**: Explicitly typed interfaces
- **State management**: Use TanStack Query for server state
- **Styling**: Tailwind classes with cn() utility for merging

### Database Patterns

- **Schema-first**: Define Zod schemas before implementation
- **Migrations**: Use Drizzle Kit for schema changes
- **Queries**: Type-safe with Drizzle ORM
- **Transactions**: Use Drizzle transactions for complex operations

## 🤝 Contributing

1. **Fork the repository**
2. **Create a feature branch**: `git checkout -b feature/amazing-feature`
3. **Make your changes** following the code style guidelines
4. **Add tests** for new functionality
5. **Run tests**: `bun run test`
6. **Commit changes**: `git commit -m 'Add amazing feature'`
7. **Push branch**: `git push origin feature/amazing-feature`
8. **Create a Pull Request**

### Development Guidelines

- **Follow the existing patterns** in the codebase
- **Write tests** for new features
- **Update documentation** when adding new features
- **Use meaningful commit messages**
- **Keep PRs focused** on a single feature or fix

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## 🆘 Support

- **Issues**: [Report bugs and request features](https://github.com/your-org/commissary/issues)
- **Discussions**: [Ask questions and share ideas](https://github.com/your-org/commissary/discussions)
- **Documentation**: [Wiki and guides](https://github.com/your-org/commissary/wiki)

## 🙏 Acknowledgments

- Built with [Tauri](https://tauri.app/) for cross-platform desktop development
- UI components from [Radix UI](https://radix-ui.com/) and [shadcn/ui](https://ui.shadcn.com/)
- AI integration powered by [Vercel AI SDK](https://sdk.vercel.ai/)
- Database management with [Drizzle ORM](https://orm.drizzle.team/)
- Authentication with [Better-auth](https://www.better-auth.com/)