## UI/UX Audit Checklist

### 1. Layout & Structure

* [ ] Page width
* [ ] Maximum content width (`max-width`)
* [ ] Content alignment
* [ ] Grid / Flex structure
* [ ] Columns and rows
* [ ] Consistency across pages
* [ ] Header / Sidebar / Content / Footer structure
* [ ] Section heights
* [ ] Proper use of available screen space
* [ ] Content being clipped or cut off

### 2. Spacing

* [ ] Margins
* [ ] Padding
* [ ] Gaps between elements
* [ ] Spacing between sections
* [ ] Card internal spacing
* [ ] Spacing between headings and content
* [ ] Consistency of spacing
* [ ] Excessive or insufficient whitespace
* [ ] Vertical rhythm

### 3. Responsive Design

* [ ] Desktop
* [ ] Laptop
* [ ] Tablet
* [ ] Mobile
* [ ] Breakpoints
* [ ] Layout changes between screen sizes
* [ ] Horizontal overflow
* [ ] Incorrect text wrapping
* [ ] Elements going outside the viewport
* [ ] Tables / Cards / Forms on smaller screens

### 4. Scrolling

* [ ] Overall page scrolling
* [ ] Scrolling inside containers
* [ ] Scrolling inside tables
* [ ] Scrolling inside sidebars
* [ ] Nested scrolling
* [ ] Unnecessary scrollbars
* [ ] Content being cut off because of `overflow: hidden`
* [ ] Sticky/fixed headers while scrolling
* [ ] Sticky/fixed sidebars while scrolling
* [ ] Scroll position when navigating between screens

### 5. Modals / Popups / Drawers

* [ ] Correct positioning
* [ ] Correct width and height
* [ ] Popup staying within viewport
* [ ] Overlay behavior
* [ ] Close button
* [ ] ESC to close
* [ ] Click outside to close
* [ ] Background scrolling when popup is open
* [ ] Internal popup scrolling
* [ ] Mobile behavior
* [ ] Z-index issues
* [ ] Nested modals/popups
* [ ] Focus management
* [ ] Body scroll locking

### 6. Hover / Active / Focus States

* [ ] Button hover
* [ ] Link hover
* [ ] Card hover
* [ ] Table row hover
* [ ] Active states
* [ ] Selected states
* [ ] Focus states
* [ ] Keyboard navigation
* [ ] Disabled states
* [ ] Loading states
* [ ] Interactive elements providing proper visual feedback

### 7. Tooltips

* [ ] Correct trigger behavior
* [ ] Correct positioning
* [ ] Tooltip stays within viewport
* [ ] Tooltip does not cover important content
* [ ] Correct behavior near screen edges
* [ ] Mobile behavior
* [ ] Appropriate delay
* [ ] Tooltip does not get stuck
* [ ] Long tooltip content
* [ ] Accessibility

### 8. Typography

* [ ] Font sizes
* [ ] Font weights
* [ ] Line heights
* [ ] Letter spacing
* [ ] Heading hierarchy
* [ ] Long text handling
* [ ] Text wrapping
* [ ] Text truncation
* [ ] Ellipsis behavior
* [ ] Button text alignment
* [ ] Card/table text alignment

### 9. Components

* [ ] Buttons
* [ ] Inputs
* [ ] Selects
* [ ] Dropdowns
* [ ] Checkboxes
* [ ] Radio buttons
* [ ] Toggles
* [ ] Tabs
* [ ] Cards
* [ ] Tables
* [ ] Pagination
* [ ] Breadcrumbs
* [ ] Navigation
* [ ] Badges
* [ ] Alerts
* [ ] Empty states

For every component, verify:

* [ ] Default state
* [ ] Hover state
* [ ] Active state
* [ ] Focus state
* [ ] Disabled state
* [ ] Loading state
* [ ] Error state
* [ ] Empty state

### 10. Forms & Validation

* [ ] Labels
* [ ] Placeholders
* [ ] Required fields
* [ ] Error messages
* [ ] Success states
* [ ] Real-time validation
* [ ] Submit validation
* [ ] Long error messages
* [ ] Layout changes when errors appear
* [ ] Keyboard navigation
* [ ] Autofocus behavior

### 11. Visual Consistency

* [ ] Colors
* [ ] Border radius
* [ ] Shadows
* [ ] Borders
* [ ] Icons
* [ ] Icon sizes
* [ ] Button heights
* [ ] Input heights
* [ ] Card styles
* [ ] Consistency across pages
* [ ] Consistent use of the design system

### 12. Accessibility

* [ ] Color contrast
* [ ] Visible focus states
* [ ] Keyboard navigation
* [ ] Correct tab order
* [ ] Screen reader labels
* [ ] Appropriate ARIA usage
* [ ] Semantic buttons instead of clickable divs
* [ ] Image alt text
* [ ] Form labels
* [ ] Modal focus trapping
* [ ] `prefers-reduced-motion`

### 13. Interaction & UX

* [ ] It is clear what is clickable
* [ ] Feedback after user actions
* [ ] Loading states
* [ ] Skeleton states
* [ ] Empty states
* [ ] Error states
* [ ] Success states
* [ ] Confirmation dialogs
* [ ] Undo functionality where appropriate
* [ ] Destructive action handling
* [ ] Navigation between screens
* [ ] Back behavior
* [ ] State persistence

### 14. UX Performance

* [ ] Layout shifts
* [ ] Visual jumps during loading
* [ ] Image loading
* [ ] Animations
* [ ] Transitions
* [ ] Heavy components
* [ ] Scroll performance
* [ ] Large lists
* [ ] Loading performance

### 15. Edge Cases

* [ ] Very long text
* [ ] Very long usernames/names
* [ ] Very large numbers
* [ ] Zero results
* [ ] Large amounts of data
* [ ] Missing images
* [ ] Broken images
* [ ] Error states
* [ ] Slow loading states
* [ ] Modals with large amounts of content
* [ ] Tooltips near viewport edges
* [ ] Very small screens
* [ ] Very large screens
* [ ] Browser zoom at 200%
* [ ] Browser window resizing

### 16. Code & Implementation Quality

* [ ] Inconsistent CSS values
* [ ] Duplicate styles
* [ ] Hardcoded dimensions causing layout issues
* [ ] Incorrect `overflow` usage
* [ ] Incorrect `z-index` usage
* [ ] Unnecessary absolute positioning
* [ ] Inconsistent breakpoints
* [ ] Components that should be reusable
* [ ] Inconsistent spacing values
* [ ] Inconsistent typography values
* [ ] Design-system violations
* [ ] Potential UI bugs caused by implementation

### 17. Audit Output

For **every issue found**, report:

* [ ] Issue
* [ ] Location
* [ ] What is wrong
* [ ] Why it is a UI/UX problem
* [ ] Severity: **Critical / High / Medium / Low**
* [ ] Recommended fix
* [ ] File name
* [ ] Component name
* [ ] Line number, when possible
* [ ] Whether the same issue exists elsewhere
* [ ] Recommended global/design-system fix when applicable

**Important:** The agent should complete the full audit **before making any code changes**.
