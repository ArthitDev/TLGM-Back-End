const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const db = require('../../db');

class LoginController {
    async login(req, res) {
        try {
            const { username, password } = req.body;
            
            const [users] = await db.execute(
                'SELECT * FROM users WHERE username = ?',
                [username]
            );
            const user = users[0];
            
            if (!user) {
                return res.status(401).json({ message: 'Invalid username or password' });
            }

            const isValidPassword = await bcrypt.compare(password, user.password);
            if (!isValidPassword) {
                return res.status(401).json({ message: 'Invalid username or password' });
            }

            const token = jwt.sign(
                { userId: user.id, username: user.username },
                process.env.JWT_SECRET,
                { expiresIn: '5s' }
            );

            res.status(200).json({
                message: 'Login successful',
                token,
                user: {
                    id: user.id,
                    username: user.username,
                    name: user.name
                }
            });

        } catch (error) {
            console.error('Login error:', error);
            res.status(500).json({ message: 'Internal server error' });
        }
    }
}

module.exports = new LoginController();
