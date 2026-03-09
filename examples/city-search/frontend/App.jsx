import { useState, useCallback, useEffect, useMemo } from 'react';
import WebMQClient from '@webmq-frontend';
import ResultCard from './components/ResultCard';

export default function CitySearch() {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [isSearching, setIsSearching] = useState(false);
  const [currentSearchId, setCurrentSearchId] = useState(null);

  // WebMQ setup - no static subscriptions, only dynamic ones based on search
  const webMQClient = useMemo(() => new WebMQClient({
    url: 'ws://localhost:8080', sessionId: crypto.randomUUID(), logLevel: 'DEBUG'
  }), []);
  useEffect(() => {
    webMQClient.connect();
    return () => webMQClient.disconnect();
  }, [webMQClient]);

  const handleResults = useCallback((message) => {
    setResults((prev) => [...prev, ...message.results]);
  }, []);
  useEffect(() => {
    if (!currentSearchId) return;
    webMQClient.listen(`search.results.${currentSearchId}`, handleResults);
    return () => webMQClient.unlisten(`search.results.${currentSearchId}`, handleResults);
  }, [currentSearchId, handleResults, webMQClient]);

  const handleSearch = (e) => {
    e.preventDefault();
    if (!query.trim()) return;

    const searchId = crypto.randomUUID();

    setCurrentSearchId(searchId);
    setResults([]);
    setIsSearching(true);

    // Publish search request
    webMQClient.publish(`search.request.${searchId}`, {
      searchId,
      query: query.trim(),
    });

    // Stop showing loading after 5 seconds
    setTimeout(() => setIsSearching(false), 5000);
  };

  return (
    <div className="container">
      <div className="header">
        <h1>🌍 City Explorer</h1>
        <p>
          Search for a city to discover weather, info, and images from multiple
          sources
        </p>
      </div>

      <form onSubmit={handleSearch}>
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Enter a city name (e.g., Paris, London, Tokyo)"
          autoFocus
        />
        <button type="submit">Search</button>
      </form>

      {isSearching && results.length === 0 && (
        <div className="loading">
          <div className="spinner"></div>
          <p>Searching across multiple sources...</p>
        </div>
      )}

      {results.length > 0 && (
        <div className="results">
          {results.map((result) => (
            <ResultCard key={result.id} result={result} />
          ))}
        </div>
      )}

      {!isSearching && results.length === 0 && query && (
        <div className="no-results">
          <p>No results yet. Try searching for a different city!</p>
        </div>
      )}
    </div>
  );
}
