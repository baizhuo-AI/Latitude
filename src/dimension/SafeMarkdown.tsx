import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * The assistant can quote material from tools and the open web, so its text is
 * always untrusted. Keep the supported link surface deliberately narrow and
 * never opt in to raw HTML parsing.
 */
function safeExternalUrl(url: string): string {
  const normalized = url.trim();
  return /^https?:\/\//i.test(normalized) ? normalized : "";
}

const MARKDOWN_COMPONENTS: Components = {
  a({ href, children, node: _node, ...props }) {
    if (!href) {
      return <span className="dim-markdown__unsafe-link">{children}</span>;
    }
    return (
      <a
        {...props}
        href={href}
        target="_blank"
        rel="noopener noreferrer nofollow"
      >
        {children}
        <span className="dim-markdown__external" aria-hidden="true">
          ↗
        </span>
      </a>
    );
  },
  input({ node: _node, ...props }) {
    // GFM task-list checkboxes are display-only inside an assistant response.
    return <input {...props} disabled />;
  }
};

export function SafeMarkdown({ content }: { content: string }) {
  return (
    <div className="dim-markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={MARKDOWN_COMPONENTS}
        skipHtml
        urlTransform={safeExternalUrl}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
