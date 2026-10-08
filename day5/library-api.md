# Library Books REST API Design

A RESTful web API specification for managing a library's book collection resource.

---

## Endpoints

### 1. List All Books
* **Method**: `GET`
* **Path**: `/api/books`
* **Description**: Retrieves a complete list of all books in the library catalog.
* **Success Status Code**: `200 OK`

### 2. List Books by Author
* **Method**: `GET`
* **Path**: `/api/books?author=George+Orwell`
* **Description**: Filters and retrieves books written by a specific author using a query parameter.
* **Success Status Code**: `200 OK`

### 3. Get One Book
* **Method**: `GET`
* **Path**: `/api/books/42`
* **Description**: Retrieves the details of a single book identified by its ID.
* **Success Status Code**: `200 OK`

### 4. Create a Book
* **Method**: `POST`
* **Path**: `/api/books`
* **Description**: Adds a new book to the library catalog.
* **Example Request Body**:
  ```json
  {
    "title": "Things Fall Apart",
    "author": "Chinua Achebe",
    "isbn": "9780385474542",
    "publishedYear": 1958,
    "copiesAvailable": 5
  }