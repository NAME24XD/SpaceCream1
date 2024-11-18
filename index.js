const express = require('express');
const mysql = require('mysql2');
const ejs = require('ejs');
const bodyParser = require('body-parser');
const session = require('express-session');
const multer = require('multer');
const path = require('path');

// const bcrypt = require('bcryptjs');

const app = express();
const port = 3000;

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: true }));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.use(express.static('public'));

app.use(bodyParser.urlencoded({ extended: true }));
app.use(session({
    secret: 'secret-key',
    resave: false,
    saveUninitialized: true
}));


const db = mysql.createConnection({
    host: '127.0.0.1',
    user: 'root',
    password: 'root',
    database: 'spacecream'
});

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, 'uploads/'); // Папка для загрузки изображений
    },
    filename: (req, file, cb) => {
        cb(null, Date.now() + path.extname(file.originalname)); // Уникальное имя файла
    }
});

const upload = multer({ storage: storage });

// Добавление продукта с изображением
app.post('/add', upload.single('image'), (req, res) => {
    const { name, description, price } = req.body;
    const imagePath = req.file ? req.file.path : null; // Получаем путь к изображению

    db.query('INSERT INTO products (name, description, price, image_path) VALUES (?, ?, ?, ?)', 
    [name, description, price, imagePath], (err) => {
        if (err) {
            console.error('Error adding product:', err);
            return res.status(500).send('Error adding product');
        }
        res.redirect('/'); 
    });
});

const isAuthenticated = (req, res, next) => {
    if (req.session.authenticated) {
        next();
    } else {
        res.redirect('/login');
    }
};

app.get('/', (req, res) => {
    db.query('SELECT * FROM products', (err, results) => {
        if (err) {
            console.error('Error fetching products:', err);
            return res.status(500).send('Error fetching products');
        }
        
        const products = results.map(product => {
            if (product.image_path) {
                product.image_url = `/uploads/${path.basename(product.image_path)}`;
            }
            return product;
        });

        const userId = req.session.userId; 

        if (userId) {
            db.query('SELECT priority, username FROM users WHERE id = ?', [userId], (err, userResults) => {
                if (err) {
                    console.error('Error fetching user data:', err);
                    return res.status(500).send('Error fetching user data');
                }
                
                const userPriority = userResults[0]?.priority || 0;
                const userUsername = userResults[0]?.username || '';
                let cornerLetter = (userPriority === 2) ? 'A' : '';

                res.render('index', { products, cornerLetter, userPriority, userUsername });
            });
        } else {
            res.render('index', { products, cornerLetter: '', userPriority: 0, userUsername: '' });
        }
    });
});

app.post('/update-profile', isAuthenticated, (req, res) => {
    const { userId, newName } = req.body;

    db.query('UPDATE users SET username = ? WHERE id = ?', [newName, userId], (err) => {
        if (err) {
            console.error('Ошибка при обновлении пользователя:', err);
            return res.status(500).send('Ошибка при обновлении пользователя');
        }
        res.json({ message: 'Профиль успешно обновлён' });
    });
});

// Обработка GET запроса на страницу корзины
app.get('/cart', isAuthenticated, (req, res) => {
    const cart = req.session.cart || [];
    const userPriority = req.session.userPriority || 0;

    if (cart.length > 0 && cart.every(item => item && item.product_id)) {
        const placeholders = cart.map(() => '?').join(',');
        db.query(`SELECT id, name, description, price FROM products WHERE id IN (${placeholders})`, cart.map(item => item.product_id), (err, results) => {
            if (err) {
                console.error('Error fetching cart items:', err);
                return res.status(500).send('Error fetching cart items');
            }

            const cartItems = [];

            results.forEach((product, index) => {
                const quantity = cart[index].quantity;
                cartItems.push({
                    id: product.id,
                    name: product.name,
                    description: product.description,
                    price: product.price,
                    quantity
                });
            });

            const totalCartPrice = cartItems.reduce((total, item) => total + item.price * item.quantity, 0);
            res.render('cart', { cart: cartItems, totalCartPrice, isAuthenticated: req.session.authenticated, userPriority });
        });
    } else {
        res.render('cart', { cart: [], totalCartPrice: 0, isAuthenticated: req.session.authenticated, userPriority });
    }
});

// Обработка добавления в корзину
app.post('/cart', (req, res) => {
    const { product_id, quantity } = req.body;
    req.session.cart = req.session.cart || []; 
    req.session.cart.push({ product_id, quantity }); 
    res.redirect('/');
});

// Удаление товара из корзины
app.post('/cart/remove', (req, res) => {
    const productIdToRemove = req.body.product_id;
    const cart = req.session.cart || [];
    req.session.cart = cart.filter(item => item.product_id !== productIdToRemove);
    res.redirect('/cart');
});

// Страница Оформления заказа
app.get('/order', isAuthenticated, (req, res) => {
    const userPriority = req.session.userPriority || 0;
    res.render('order', { isAuthenticated: req.session.authenticated, userPriority });
});

// Обработка оформления заказа
app.post('/order', isAuthenticated, (req, res) => {
    const { name, address } = req.body;
    const userId = req.session.userId; 
    const orderDate = new Date(); 
    const cart = req.session.cart || [];

    // Создание нового заказа в таблице orders
    db.query('INSERT INTO orders (user_id, order_date, name, address) VALUES (?, ?, ?, ?)',
        [userId, orderDate, name, address], (err, result) => {
            if (err) {
                console.error('Error creating order:', err);
                return res.status(500).send('Error creating order');
            }

            const orderId = result.insertId;
            const promises = cart.map(item => {
                return new Promise((resolve, reject) => {
                    db.query('INSERT INTO order_items (order_id, product_id, quantity) VALUES (?, ?, ?)',
                        [orderId, item.product_id, item.quantity], (err) => {
                            if (err) {
                                reject(err);
                            } else {
                                resolve();
                            }
                        });
                });
            });

            // Ждем завершения всех запросов к базе данных
            Promise.all(promises)
                .then(() => {
                    req.session.cart = [];
                    res.redirect('/cart');
                })
                .catch(error => {
                    console.error('Error adding order items:', error);
                    res.status(500).send('Error adding order items');
                });
        });
});
// Страница Авторизация
app.get('/login', (req, res) => {
    res.render('login', { isAuthenticated: req.session.authenticated });
});

// Роуты для админ-панели
app.get('/admin', isAuthenticated, (req, res) => {
    if (req.session.authenticated && req.session.userPriority === 2) {
        const cornerLetter = 'A';
        res.render('admin', { cornerLetter });
    } else {
        res.redirect('/');
    }
});

// Роут для отображения страницы управления продуктами
app.get('/admin/products', isAuthenticated, (req, res) => {
    if (req.session.authenticated && req.session.userPriority === 2) {
        db.query('SELECT * FROM products', (err, results) => {
            if (err) {
                console.error('Error fetching products:', err);
                return res.status(500).send('Error fetching products');
            }
            const products = results;
            const cornerLetter = 'A'; // Пример значения для cornerLetter
            res.render('adminProducts', { products, cornerLetter });
        });
    } else {
        res.redirect('/');
    }
});

// Роут для обновления информации о продукте
app.post('/admin/products/update/:productId', isAuthenticated, (req, res) => {
    const { name, description, price } = req.body;
    const productId = req.params.productId;

    if (req.session.authenticated && req.session.userPriority === 2) {
        db.query('UPDATE products SET name = ?, description = ?, price = ? WHERE id = ?', [name, description, price, productId], (err) => {
            if (err) {
                console.error('Error updating product:', err);
                return res.status(500).send('Error updating product');
            }
            res.redirect('/admin/products');
        });
    } else {
        res.redirect('/');
    }
});

// Роут для удаления продукта
app.post('/admin/products/delete/:productId', isAuthenticated, (req, res) => {
    const productId = req.params.productId;

    if (req.session.authenticated && req.session.userPriority === 2) {
        db.query('DELETE FROM products WHERE id = ?', [productId], (err) => {
            if (err) {
                console.error('Error deleting product:', err);
                return res.status(500).send('Error deleting product');
            }
            res.redirect('/admin/products');
        });
    } else {
        res.redirect('/');
    }
});

// Роут для отображения зарегистрированных пользователей в админ панели
app.get('/admin/users', isAuthenticated, (req, res) => {
    if (req.session.authenticated && req.session.userPriority === 2) {
        db.query('SELECT * FROM users', (err, users) => {
            if (err) {
                console.error('Error fetching users:', err);
                return res.status(500).send('Error fetching users');
            }
            res.render('adminUsers', { users });
        });
    } else {
        res.redirect('/');
    }
});

// Роут для смены приоритета пользователя
app.post('/admin/users/switchPriority/:userId', isAuthenticated, (req, res) => {
    const userId = req.params.userId;
    if (req.session.authenticated && req.session.userPriority === 2) {
        db.query('SELECT priority FROM users WHERE id = ?', [userId], (err, results) => {
            if (err) {
                console.error('Error fetching user priority:', err);
                return res.status(500).send('Error fetching user priority');
            }

            if (results.length === 0) {
                return res.status(404).send('User not found');
            }

            const currentPriority = results[0].priority;
            const newPriority = currentPriority === 1 ? 2 : 1; 

            db.query('UPDATE users SET priority = ? WHERE id = ?', [newPriority, userId], (err) => {
                if (err) {
                    console.error('Error updating user priority:', err);
                    return res.status(500).send('Error updating user priority');
                }

                res.redirect('/admin/users');
            });
        });
    } else {
        res.redirect('/');
    }
});


// Роут для отображения страницы управления заказами
app.get('/admin/orders', isAuthenticated, (req, res) => {
    if (req.session.authenticated && req.session.userPriority) {
        db.query('SELECT * FROM orders', (err, orders) => {
            if (err) {
                console.error('Error fetching orders:', err);
                return res.status(500).send('Error fetching orders');
            }
            const promises = orders.map(order => {
                return new Promise((resolve, reject) => {
                    db.query('SELECT products.name, products.description, products.price, order_items.quantity FROM products INNER JOIN order_items ON products.id = order_items.product_id WHERE order_items.order_id = ?', [order.id], (err, items) => {
                        if (err) {
                            reject(err);
                        } else {
                            order.items = items;
                            resolve(order);
                        }
                    });
                });
            });
            Promise.all(promises)
                .then(ordersWithItems => {
                    res.render('adminOrders', { orders: ordersWithItems });
                })
                .catch(error => {
                    console.error('Error fetching order items:', error);
                    res.status(500).send('Error fetching order items');
                });
        });
    } else {
        res.redirect('/login');
    }
});

app.post('/register', (req, res) => {
    const { username, password, email } = req.body;

    // Проверяем, существует ли пользователь или почта
    db.query('SELECT * FROM users WHERE username = ? OR email = ?', [username, email], (err, results) => {
        if (err) {
            console.error('Ошибка при проверке имени пользователя или почты:', err);
            return res.status(500).send('Ошибка при проверке имени пользователя или почты');
        }

        if (results.length > 0) {
            const errorMessages = [];
            if (results.some(user => user.username === username)) {
                errorMessages.push('Пользователь с таким именем уже существует');
            }
            if (results.some(user => user.email === email)) {
                errorMessages.push('Пользователь с такой почтой уже существует');
            }
            return res.render('registration', { error: errorMessages.join(' ') });
        }

        // Если пользователь не найден, добавляем нового
        db.query('INSERT INTO users (username, password, email) VALUES (?, ?, ?)', [username, password, email], (err, result) => {
            if (err) {
                console.error('Ошибка при добавлении пользователя:', err);
                return res.status(500).send('Ошибка при добавлении пользователя');
            }

            // Используем результат вставки для получения ID нового пользователя
            const newUserId = result.insertId;

            // Теперь можно получить информацию о новом пользователе
            req.session.authenticated = true;
            req.session.userId = newUserId;
            req.session.username = username; // Здесь используем username, так как мы его уже получили
            req.session.userPriority = 0; // Установите приоритет по умолчанию, если необходимо

            res.redirect('/');
        });
    });
});

// Логика входа
app.post('/login', (req, res) => {
    const { username, password } = req.body;
    db.query('SELECT * FROM users WHERE username = ?', [username], (err, results) => {
        if (err) {
            console.error('Ошибка при получении пользователя:', err);
            return res.status(500).send('Ошибка при получении пользователя');
        }

        if (results.length === 0) {
            // Пользователь не найден
            return res.render('login', { error: 'Такого пользователя нет - зарегистрируйтесь', isAuthenticated: req.session.authenticated });
        } else {
            const user = results[0];
            if (user.password === password) {
                // Вход успешен
                req.session.authenticated = true;
                req.session.userId = user.id;
                req.session.username = user.username;
                req.session.userPriority = user.priority;
                return res.redirect('/');
            } else {
                // Неправильный пароль
                return res.render('login', { error: 'Неправильный пароль', isAuthenticated: req.session.authenticated });
            }
        }
    });
});

// Получение всех отзывов для определенного продукта
app.get('/reviews/:productId', (req, res) => {
    const productId = req.params.productId;

    db.query('SELECT *, DATE_FORMAT(created_at, "%Y-%m-%d") as formatted_date FROM reviews WHERE product_id = ?', [productId], (err, reviews) => {
        if (err) {
            console.error('Error fetching reviews:', err);
            return res.status(500).send('Error fetching reviews');
        }

        res.render('reviews', { productId, reviews });
    });
});

// Добавление нового отзыва
app.post('/reviews', isAuthenticated, (req, res) => {
    const { product_id, review_text, rating } = req.body;
    const userId = req.session.userId;
    const username = req.session.username;

    const createdAt = new Date();

    db.query('INSERT INTO reviews (user_id, product_id, review_text, rating, created_at, username) VALUES (?, ?, ?, ?, ?, ?)',
        [userId, product_id, review_text, rating, createdAt, username], (err) => {
            if (err) {
                console.error('Error adding review:', err);
                return res.status(500).send('Error adding review');
            }
            res.redirect(`/reviews/${product_id}`);
    });
});

app.get('/product/:id/reviews', (req, res) => {
    const productId = req.params.id;
    db.query('SELECT * FROM reviews WHERE product_id = ?', [productId], (err, reviews) => {
        if (err) {
            console.error('Error fetching reviews:', err);
            return res.status(500).send('Error fetching reviews');
        }
        res.render('reviews', { reviews, productId });
    });
});

// Роут для страницы справки
app.get('/help', (req, res) => {
    res.render('help');
});

// Выход из аккаунта
app.get('/logout', (req, res) => {
    req.session.authenticated = false;
    res.redirect('/login');
});

app.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
});

