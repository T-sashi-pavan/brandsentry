import Document, {
  Html,
  Head,
  Main,
  NextScript,
  type DocumentContext,
  type DocumentInitialProps,
} from 'next/document';

interface DocumentProps extends DocumentInitialProps {
  nonce?: string;
}

// Reads the per-request CSP nonce middleware.ts set on the request headers
// and threads it to NextScript below, so the script tags Next.js itself
// injects (webpack runtime, page chunks, __NEXT_DATA__) carry the nonce
// the CSP's script-src requires — without this, Next's own bootstrap
// scripts would be blocked by the strict CSP just like anything else.
class MyDocument extends Document<DocumentProps> {
  static async getInitialProps(ctx: DocumentContext): Promise<DocumentProps> {
    const initialProps = await Document.getInitialProps(ctx);
    const rawNonce = ctx.req?.headers['x-nonce'] || ctx.res?.getHeader?.('x-nonce');
    const nonce = Array.isArray(rawNonce) ? rawNonce[0] : rawNonce !== undefined ? String(rawNonce) : undefined;
    return { ...initialProps, nonce };
  }

  render() {
    return (
      <Html lang="en">
        <Head nonce={this.props.nonce} />
        <body>
          <Main />
          <NextScript nonce={this.props.nonce} />
        </body>
      </Html>
    );
  }
}

export default MyDocument;
