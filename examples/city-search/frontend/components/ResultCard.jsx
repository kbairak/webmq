import { useState } from 'react';

export default function ResultCard({ result }) {
  const { type, title, data } = result;

  if (type === 'keyvalue') {
    return (
      <div className="result-card">
        <h3>{title}</h3>
        <div className="keyvalue-grid">
          {Object.entries(data).map(([key, value]) => (
            <div key={key} className="keyvalue-item">
              <strong>{key}:</strong> <span>{value}</span>
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (type === 'markdown') {
    // Simple markdown rendering (just paragraphs and links)
    const renderMarkdown = (text) => {
      // Convert **bold** to <strong>
      text = text.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
      // Convert [text](url) to <a>
      text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
      // Convert newlines to <br>
      text = text.replace(/\n/g, '<br/>');
      return text;
    };

    return (
      <div className="result-card">
        <h3>{title}</h3>
        <div className="markdown-content" dangerouslySetInnerHTML={{ __html: renderMarkdown(data) }} />
      </div>
    );
  }

  if (type === 'image') {
    const [imageError, setImageError] = useState(false);

    return (
      <div className="result-card image-card">
        {!imageError ? (
          <img
            src={data.thumbUrl || data.url}
            alt={title}
            onError={() => setImageError(true)}
            loading="lazy"
          />
        ) : (
          <div className="image-error">Image failed to load</div>
        )}
        <div className="image-caption">
          <strong>{title}</strong>
          {data.caption && <p>{data.caption.substring(0, 150)}{data.caption.length > 150 ? '...' : ''}</p>}
          {data.author && <p className="author">By {data.author}</p>}
        </div>
      </div>
    );
  }

  if (type === 'list') {
    return (
      <div className="result-card">
        <h3>{title}</h3>
        <ul className="list-content">
          {data.map((item, idx) => (
            <li key={idx}>{item}</li>
          ))}
        </ul>
      </div>
    );
  }

  if (type === 'text') {
    return (
      <div className="result-card">
        <h3>{title}</h3>
        <p>{data}</p>
      </div>
    );
  }

  return null;
}
