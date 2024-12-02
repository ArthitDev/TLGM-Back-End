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
                { userId: user.userid, username: user.username },
                process.env.JWT_SECRET,
                { expiresIn: '1d' }
            );

            res.cookie('token', token, {
                httpOnly: true,
                secure: true,
                sameSite: 'none',
                maxAge: 24 * 60 * 60 * 1000
            });

            res.status(200).json({
                message: 'Login successful',
                user: {
                    id: user.userid,
                    username: user.username,
                    name: user.name,
                    role: user.role
                }
            });

        } catch (error) {
            console.error('Login error:', error);
            res.status(500).json({ message: 'Internal server error' });
        }
    }

    async logout(req, res) {
        try {
            res.cookie('token', '', {
                httpOnly: true,
                secure: true,
                sameSite: 'none',
                expires: new Date(0)
            });

            res.status(200).json({
                success: true,
                message: 'Logged out successfully'
            });
        } catch (error) {
            console.error('Logout error:', error);
            res.status(500).json({ message: 'Internal server error' });
        }
    }
}

module.exports = new LoginController();
