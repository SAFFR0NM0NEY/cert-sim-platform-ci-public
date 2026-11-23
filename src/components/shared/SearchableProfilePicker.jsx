import { useMemo, useState } from 'react';

const defaultGetValue = (item) => item?.id ?? '';
const defaultGetPrimaryText = (item) =>
  item?.displayName ||
  item?.display_name ||
  item?.full_name ||
  item?.email ||
  item?.id ||
  'Unknown profile';
const defaultGetSecondaryText = (item) => item?.email ?? '';
const defaultGetBadgeText = (item) => item?.groupName || item?.status || '';
const defaultGetSearchText = (item) =>
  [
    item?.displayName,
    item?.display_name,
    item?.full_name,
    item?.username,
    item?.email,
    item?.groupName,
    item?.campusName,
    item?.organisationName,
    item?.role,
    item?.status,
  ]
    .filter(Boolean)
    .join(' ');
const hiddenListMessage =
  'Start typing to search visible profiles. Full lists are not shown by default.';

export default function SearchableProfilePicker({
  emptyMessage = 'No matching profiles found.',
  getBadgeText = defaultGetBadgeText,
  getPrimaryText = defaultGetPrimaryText,
  getSearchText = defaultGetSearchText,
  getSecondaryText = defaultGetSecondaryText,
  getValue = defaultGetValue,
  helpText = '',
  items = [],
  label,
  maxVisible = 8,
  minimumSearchLength = 1,
  onChange,
  placeholder = 'Search by display name, username, or email',
  required = false,
  value,
}) {
  const [query, setQuery] = useState('');
  const selectedItem = useMemo(
    () => items.find((item) => getValue(item) === value) ?? null,
    [getValue, items, value],
  );
  const normalizedQuery = normalizeText(query);
  const canShowMatches =
    normalizedQuery.length >= minimumSearchLength || Boolean(selectedItem);
  const matchedItems = useMemo(() => {
    if (!canShowMatches) {
      return [];
    }

    const matches = normalizedQuery
      ? items.filter((item) =>
          normalizeText(getSearchText(item)).includes(normalizedQuery),
        )
      : selectedItem
        ? [selectedItem]
        : [];

    return matches.slice(0, maxVisible);
  }, [
    canShowMatches,
    getSearchText,
    items,
    maxVisible,
    normalizedQuery,
    selectedItem,
  ]);

  return (
    <div className="searchable-profile-picker">
      <label>
        <span>
          {label}
          {required ? ' *' : ''}
        </span>
        <input
          type="search"
          value={query}
          placeholder={placeholder}
          aria-required={required}
          onChange={(event) => setQuery(event.target.value)}
        />
      </label>

      {helpText ? <p className="picker-help">{helpText}</p> : null}

      {selectedItem ? (
        <div className="selected-profile-summary">
          <span>
            <strong>{getPrimaryText(selectedItem)}</strong>
            {getSecondaryText(selectedItem) ? (
              <small>{getSecondaryText(selectedItem)}</small>
            ) : null}
          </span>
          <button
            className="secondary-button compact-button"
            type="button"
            onClick={() => onChange('', null)}
          >
            Clear
          </button>
        </div>
      ) : null}

      {!canShowMatches ? (
        <p className="picker-help">{hiddenListMessage}</p>
      ) : null}

      {canShowMatches && matchedItems.length === 0 ? (
        <p className="picker-help">{emptyMessage}</p>
      ) : null}

      {matchedItems.length > 0 ? (
        <ul className="searchable-profile-list">
          {matchedItems.map((item) => {
            const itemValue = getValue(item);
            const isSelected = itemValue === value;
            const badgeText = getBadgeText(item);

            return (
              <li key={itemValue}>
                <button
                  className={isSelected ? 'selected' : ''}
                  type="button"
                  onClick={() => onChange(itemValue, item)}
                >
                  <span>
                    <strong>{getPrimaryText(item)}</strong>
                    {getSecondaryText(item) ? (
                      <small>{getSecondaryText(item)}</small>
                    ) : null}
                  </span>
                  {badgeText ? <em>{badgeText}</em> : null}
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}

function normalizeText(value) {
  return String(value ?? '').trim().toLowerCase();
}
