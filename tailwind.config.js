/** @type {import('tailwindcss').Config} */
export default {
  // Dark mode is a class on <html>, set by lib/theme.ts: the household can
  // choose light or dark outright, not only follow the phone.
  darkMode: 'class',
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      // The palette is CSS custom properties (src/index.css), so one class
      // name carries a role in both themes: `bg-sand-50` is the page,
      // `text-ink-800` is what you read. Dark mode swaps the values, not
      // the class names. The `<alpha-value>` slot keeps `/60` working.
      colors: {
        surface: 'rgb(var(--c-surface) / <alpha-value>)', // cards, sheets, the nav bar
        scrim: 'rgb(var(--c-scrim) / <alpha-value>)', // behind a sheet; dark in both themes
        sand: {
          50: 'rgb(var(--c-sand-50) / <alpha-value>)',
          100: 'rgb(var(--c-sand-100) / <alpha-value>)',
          200: 'rgb(var(--c-sand-200) / <alpha-value>)',
          300: 'rgb(var(--c-sand-300) / <alpha-value>)',
          400: 'rgb(var(--c-sand-400) / <alpha-value>)',
          500: 'rgb(var(--c-sand-500) / <alpha-value>)',
          600: 'rgb(var(--c-sand-600) / <alpha-value>)',
          700: 'rgb(var(--c-sand-700) / <alpha-value>)',
          800: 'rgb(var(--c-sand-800) / <alpha-value>)',
          900: 'rgb(var(--c-sand-900) / <alpha-value>)',
        },
        sage: {
          50: 'rgb(var(--c-sage-50) / <alpha-value>)',
          100: 'rgb(var(--c-sage-100) / <alpha-value>)',
          200: 'rgb(var(--c-sage-200) / <alpha-value>)',
          300: 'rgb(var(--c-sage-300) / <alpha-value>)',
          400: 'rgb(var(--c-sage-400) / <alpha-value>)',
          500: 'rgb(var(--c-sage-500) / <alpha-value>)',
          600: 'rgb(var(--c-sage-600) / <alpha-value>)',
          700: 'rgb(var(--c-sage-700) / <alpha-value>)',
          800: 'rgb(var(--c-sage-800) / <alpha-value>)',
          900: 'rgb(var(--c-sage-900) / <alpha-value>)',
        },
        clay: {
          50: 'rgb(var(--c-clay-50) / <alpha-value>)',
          100: 'rgb(var(--c-clay-100) / <alpha-value>)',
          200: 'rgb(var(--c-clay-200) / <alpha-value>)',
          300: 'rgb(var(--c-clay-300) / <alpha-value>)',
          400: 'rgb(var(--c-clay-400) / <alpha-value>)',
          500: 'rgb(var(--c-clay-500) / <alpha-value>)',
          600: 'rgb(var(--c-clay-600) / <alpha-value>)',
          700: 'rgb(var(--c-clay-700) / <alpha-value>)',
          800: 'rgb(var(--c-clay-800) / <alpha-value>)',
          900: 'rgb(var(--c-clay-900) / <alpha-value>)',
        },
        ink: {
          50: 'rgb(var(--c-ink-50) / <alpha-value>)',
          100: 'rgb(var(--c-ink-100) / <alpha-value>)',
          200: 'rgb(var(--c-ink-200) / <alpha-value>)',
          300: 'rgb(var(--c-ink-300) / <alpha-value>)',
          400: 'rgb(var(--c-ink-400) / <alpha-value>)',
          500: 'rgb(var(--c-ink-500) / <alpha-value>)',
          600: 'rgb(var(--c-ink-600) / <alpha-value>)',
          700: 'rgb(var(--c-ink-700) / <alpha-value>)',
          800: 'rgb(var(--c-ink-800) / <alpha-value>)',
          900: 'rgb(var(--c-ink-900) / <alpha-value>)',
        },
        accent: {
          50: 'rgb(var(--c-accent-50) / <alpha-value>)',
          100: 'rgb(var(--c-accent-100) / <alpha-value>)',
          200: 'rgb(var(--c-accent-200) / <alpha-value>)',
          300: 'rgb(var(--c-accent-300) / <alpha-value>)',
          400: 'rgb(var(--c-accent-400) / <alpha-value>)',
          500: 'rgb(var(--c-accent-500) / <alpha-value>)',
          600: 'rgb(var(--c-accent-600) / <alpha-value>)',
          700: 'rgb(var(--c-accent-700) / <alpha-value>)',
          800: 'rgb(var(--c-accent-800) / <alpha-value>)',
          900: 'rgb(var(--c-accent-900) / <alpha-value>)',
        },
      },
      fontFamily: {
        sans: ['"Plus Jakarta Sans"', 'system-ui', 'sans-serif'],
        display: ['"Fraunces"', 'Georgia', 'serif'],
      },
      fontSize: {
        '2xs': ['0.6875rem', { lineHeight: '1rem' }],
      },
      animation: {
        'fade-in': 'fadeIn 0.4s ease-out',
        'fade-in-up': 'fadeInUp 0.5s ease-out',
        'fade-in-down': 'fadeInDown 0.5s ease-out',
        'scale-in': 'scaleIn 0.3s ease-out',
        'slide-in-right': 'slideInRight 0.3s ease-out',
        'slide-up': 'slideUp 0.4s cubic-bezier(0.16, 1, 0.3, 1)',
        'pulse-soft': 'pulseSoft 2s ease-in-out infinite',
        'shimmer': 'shimmer 1.5s linear infinite',
        'check-pop': 'checkPop 0.4s cubic-bezier(0.16, 1, 0.3, 1)',
        'spin-slow': 'spin 1.2s linear infinite',
        'progress': 'progress 1.5s ease-out forwards',
      },
      keyframes: {
        fadeIn: {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
        fadeInUp: {
          '0%': { opacity: '0', transform: 'translateY(12px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        fadeInDown: {
          '0%': { opacity: '0', transform: 'translateY(-12px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        scaleIn: {
          '0%': { opacity: '0', transform: 'scale(0.95)' },
          '100%': { opacity: '1', transform: 'scale(1)' },
        },
        slideInRight: {
          '0%': { opacity: '0', transform: 'translateX(20px)' },
          '100%': { opacity: '1', transform: 'translateX(0)' },
        },
        slideUp: {
          '0%': { opacity: '0', transform: 'translateY(100%)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        pulseSoft: {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0.6' },
        },
        shimmer: {
          '0%': { backgroundPosition: '-200% 0' },
          '100%': { backgroundPosition: '200% 0' },
        },
        checkPop: {
          '0%': { transform: 'scale(0)', opacity: '0' },
          '50%': { transform: 'scale(1.2)' },
          '100%': { transform: 'scale(1)', opacity: '1' },
        },
        progress: {
          '0%': { width: '0%' },
          '100%': { width: 'var(--progress-width, 100%)' },
        },
      },
      boxShadow: {
        'soft': '0 2px 8px rgba(38, 31, 24, 0.06), 0 1px 2px rgba(38, 31, 24, 0.04)',
        'soft-md': '0 4px 16px rgba(38, 31, 24, 0.08), 0 1px 4px rgba(38, 31, 24, 0.04)',
        'soft-lg': '0 8px 32px rgba(38, 31, 24, 0.10), 0 2px 8px rgba(38, 31, 24, 0.06)',
        'inner-soft': 'inset 0 1px 2px rgba(38, 31, 24, 0.04)',
      },
    },
  },
  plugins: [],
};
